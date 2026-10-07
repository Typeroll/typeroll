import { paths, type DeployJob, type BuildFailureLog } from '@typeroll/shared';
import { getStore } from '../datastore';
import { cloudflareClient } from '../publishing/cloudflare-oauth';
import { buildTasksPath, type BuildTask } from './queue';
import { buildInputPath, readEngineConfiguration, type BuildInput } from './state';

/**
 * The provider's own account of a failed build, attached to the deploy job.
 *
 * A failed build used to end in "Check the build log", and the build log is
 * in the build engine's Cloudflare account, which neither the customer
 * reading the error nor the release qualification reading the job can open.
 * The portal already holds the organization's build credential and reads the
 * build's status with it; it reads the log the same way, once, and keeps the
 * tail on the job so every reader (UI, API, MCP, CI) sees the reason.
 */

const TAIL_LINES = 60;
const MAX_LINE = 400;
const MAX_PAGES = 20;

// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Remove anything credential-shaped. Hex digests and commit IDs stay: they are how a failure is traced. */
export function redactLogLine(line: string): string {
  return line
    .replace(CONTROL, '')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|access_token|sig|signature|key|x-amz-[a-z-]+)=)[^&\s'"]+/gi, '$1[redacted]')
    .replace(/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s'",;]+/gi, '$1$2[redacted]')
    .replace(/\b(bearer|basic)\s+(?!\[redacted\])[^\s'"]+/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{32,}/g, '[redacted]')
    .slice(0, MAX_LINE);
}

/** Cloudflare returns `[[timestamp, message], …]`; tolerate plain strings so a format change degrades to text. */
export function logMessages(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.map(line => Array.isArray(line) ? line.find(part => typeof part === 'string') : typeof line === 'string' ? line : undefined)
    .filter((line): line is string => typeof line === 'string')
    .flatMap(line => line.split(/\r?\n/))
    .map(line => line.trimEnd())
    .filter(Boolean);
}

const FAILURE = /\b(?:error|errors|failed|failure|fatal|exception|cannot|could not|not found|exit code [1-9])\b|\bERR!/i;
const GENERIC = /^(?:build failed|failed: build command exited with code|error: exit code|npm err! a complete log|exit status \d+)/i;

/** The most specific failure line: the last one that names a cause rather than only reporting that the build stopped. */
export function failureSummary(lines: string[]): string | null {
  const failures = lines.filter(line => FAILURE.test(line));
  const specific = failures.filter(line => !GENERIC.test(line.trim()));
  const pick = specific.at(-1) ?? failures.at(-1);
  return pick ? pick.trim().slice(0, 300) : null;
}

export function summarizeLog(messages: string[], meta: Omit<BuildFailureLog, 'lines' | 'summary' | 'truncated'>, truncated: boolean): BuildFailureLog {
  const clean = messages.map(redactLogLine);
  return { ...meta, lines: clean.slice(-TAIL_LINES), truncated: truncated || clean.length > TAIL_LINES, summary: failureSummary(clean) };
}

type Client = (route: string) => Promise<any>;

/** Read every page up to a bound and keep the tail; the cause is at the end. */
export async function readCloudflareBuildLog(client: Client, accountId: string, buildId: string): Promise<{ messages: string[]; truncated: boolean }> {
  const base = `/accounts/${encodeURIComponent(accountId)}/builds/builds/${encodeURIComponent(buildId)}/logs`;
  let messages: string[] = [], cursor: string | undefined, truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client(cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base);
    messages = [...messages, ...logMessages(result?.lines)].slice(-TAIL_LINES * 4);
    if (!result?.truncated || !result?.cursor || result.cursor === cursor) return { messages, truncated: false };
    cursor = result.cursor;
    truncated = page === MAX_PAGES - 1;
  }
  return { messages, truncated };
}

/** Find the failed build task behind a job and read its provider log. Never throws: no log is not a failure of its own. */
export async function readJobBuildLog(org: string, site: string, job: DeployJob): Promise<BuildFailureLog | null> {
  const publication = (job as any).git_publication;
  const store = getStore();
  const keys: Array<[string, 'verification' | 'build']> = [];
  if (publication?.verification_task_key) keys.push([publication.verification_task_key, 'verification']);
  if (publication?.build_task_key) keys.push([publication.build_task_key, 'build']);
  for (const [key, step] of keys) {
    try {
      const task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
      if (!task || task.identity.org_id !== org || task.identity.site_id !== site || task.identity.job_id !== job.id) continue;
      if (!['failed', 'cancelled'].includes(task.status)) continue;
      const input = await store.getDoc<BuildInput>(buildInputPath(org, key));
      if (!input?.dispatch_id || (input.provider ?? 'cloudflare') !== 'cloudflare') continue;
      const engine = await readEngineConfiguration(org, 'cloudflare');
      if (!engine?.account_id) continue;
      const { messages, truncated } = await readCloudflareBuildLog(await cloudflareClient(org), engine.account_id, input.dispatch_id);
      return summarizeLog(messages, { provider: 'cloudflare', build_id: input.dispatch_id, step, error_code: task.error_code ?? null, fetched_at: new Date().toISOString() }, truncated);
    } catch { /* An unreadable log leaves the job as it was; the next read tries again. */ }
  }
  return null;
}

/** Attach the log tail to a failed job once, and name the cause in its error. */
export async function attachBuildFailureLog(org: string, site: string, job: DeployJob): Promise<DeployJob> {
  if (job.status !== 'failed' || job.failure?.provider_log) return job;
  const log = await readJobBuildLog(org, site, job);
  if (!log) return job;
  const error = log.summary && job.error && !job.error.includes(log.summary) ? `${job.error} Build log: ${log.summary}` : job.error;
  const jobPath = paths.deploy(org, site, job.id);
  await getStore().compareAndUpdateDoc<DeployJob>(jobPath, current => current.status === 'failed' && !current.failure?.provider_log,
    { error, failure: { ...(job.failure ?? { stage: job.phase ?? 'building', code: log.error_code ?? 'shared_build_failed' }), provider_log: log } } as Partial<DeployJob>);
  return (await getStore().getDoc<DeployJob>(jobPath)) ?? job;
}
