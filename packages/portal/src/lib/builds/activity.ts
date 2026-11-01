import { randomUUID } from 'node:crypto';
import { paths, type DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from './queue';
import { buildInputPath, readEngineConfiguration, engineConfigurationPath, type BuildInput, type EngineConfiguration } from './state';
import { githubBuildClient, githubBuildRoot, readGithubDispatch } from './github';
import { enginePath } from './cloudflare';

/** How long after its build a publication may still be uploading or verifying. */
const FINISHING_WINDOW_MS = 2 * 60 * 60_000;
/** A built and verified domain switch waiting for its owner's DNS approval. */
const AWAITING_APPROVAL_PHASE = 'awaiting domain cutover approval';

/**
 * Builds the organization's engine is working on, plus publications whose
 * build finished but whose own job is still uploading or verifying. A job
 * stays listed until its deploy reaches a final status, so a caller that waits
 * for an empty list never starts the next publication early.
 */
export async function activeBuilds(org: string, now = Date.now()) {
  return (await buildActivity(org, now)).active_jobs;
}

/**
 * Active builds, plus domain switches that are built and verified and only wait
 * for DNS approval. Those no longer use the build engine or the organization
 * queue, and their site's publishing lock is released, so another site may
 * publish while they wait. They are listed apart so callers that wait for an
 * empty `active_jobs` don't hold other sites back.
 */
export async function buildActivity(org: string, now = Date.now()) {
  const store = getStore();
  const [active, finished] = await Promise.all([
    store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 20 }),
    store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'completed_at', op: '>=', value: now - FINISHING_WINDOW_MS }], limit: 50 }),
  ]);
  const activeJobs = new Set(active.map(task => task.identity.job_id));
  const finishing = (await Promise.all(finished.filter(task => task.status === 'completed' && !activeJobs.has(task.identity.job_id)).map(async task => {
    const input = await store.getDoc<BuildInput>(buildInputPath(org, task.id));
    if (input?.kind !== 'publication' && input?.kind !== 'static_verification') return null;
    const job = await store.getDoc<DeployJob>(paths.deploy(org, task.identity.site_id, task.identity.job_id));
    return job && ['queued', 'running'].includes(job.status) ? { task, input, phase: job.phase ?? null } : null;
  }))).filter(entry => entry !== null);
  const seen = new Set<string>();
  const unique = finishing.filter(({ task }) => !seen.has(task.identity.job_id) && !!seen.add(task.identity.job_id));
  const awaiting = unique.filter(entry => entry.phase === AWAITING_APPROVAL_PHASE);
  const entries = [
    ...await Promise.all(active.map(async task => ({ task, input: await store.getDoc<BuildInput>(buildInputPath(org, task.id)), phase: null as string | null }))),
    ...unique.filter(entry => entry.phase !== AWAITING_APPROVAL_PHASE),
  ];
  const siteName = async (siteId: string) => (await store.getDoc<{ name: string }>(paths.site(org, siteId)))?.name ?? siteId;
  const awaitingApproval = await Promise.all(awaiting.map(async ({ task }) => ({ key: task.id, job_id: task.identity.job_id, site_id: task.identity.site_id,
    site_name: await siteName(task.identity.site_id), version_id: task.identity.version_id, status: 'awaiting_approval' as const, phase: AWAITING_APPROVAL_PHASE })));
  const jobs = await Promise.all(entries.map(async ({ task, input, phase }) => {
    const site = input?.kind !== 'qualification' ? await store.getDoc<{ name: string }>(paths.site(org, task.identity.site_id)) : null;
    const status: 'queued' | 'running' | 'publishing' = task.status === 'completed' ? 'publishing' : task.status as 'queued' | 'running';
    return { key: task.id, job_id: task.identity.job_id, site_id: task.identity.site_id, site_name: input?.kind === 'qualification' ? 'Build verification' : site?.name ?? task.identity.site_id,
      kind: input?.kind, version_id: task.identity.version_id, status, phase, provider: input?.provider ?? 'cloudflare', attempt: task.attempt, static_verification: input?.kind === 'static_verification' && status !== 'publishing' ? { completed: task.media_cursor ?? 0, total: task.media_total ?? 0 } : null, media_preparation: input?.kind !== 'static_verification' && task.media_total && status !== 'publishing' ? { completed: task.media_cursor ?? 0, total: task.media_total } : null };
  }));
  return { active_jobs: jobs, awaiting_approval: awaitingApproval };
}

export async function cancelGithubTask(org: string, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new ConnectionError('Invalid build task.', 400);
  const store = getStore(), task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  const input = await store.getDoc<BuildInput>(buildInputPath(org, key));
  if (!task || input?.provider !== 'github') throw new ConnectionError('GitHub build not found.', 404);
  const config = await readEngineConfiguration(org, 'github');
  const cancelled = await new OrganizationBuildQueue().cancel(org, key);
  if (!cancelled) throw new ConnectionError('This build has already finished. Its publication cannot be cancelled here.', 409);
  if (['publication', 'static_verification'].includes(input.kind)) await store.compareAndUpdateDoc<DeployJob>(paths.deploy(org, task.identity.site_id, task.identity.job_id), value => ['queued', 'running'].includes(value.status),
    { status: 'failed', phase: 'cancelled', error: 'The build was cancelled by an organization administrator.', finished_at: new Date().toISOString() });
  else if (input.kind === 'qualification' && config?.revision === task.engine_revision) {
    await store.compareAndUpdateDoc<EngineConfiguration>(engineConfigurationPath(org, 'github'), value => value.revision === task.engine_revision, { status: 'disabled' });
    await store.updateDoc(enginePath(org, 'github'), { revision: randomUUID(), enabled: false, state: 'setup_required', issue: { code: 'github_qualification_cancelled', message: 'Verification was cancelled. Finish build setup to try again.' } });
  }
  if (config?.revision !== task.engine_revision || !input.dispatch_nonce) return;
  try {
    const client = await githubBuildClient(config);
    const run = await readGithubDispatch(client, config, input);
    if (run && run.status !== 'completed') await client(`${githubBuildRoot(config)}/actions/runs/${run.id}/cancel`, { method: 'POST' });
  } catch { /* The revoked attempt cannot publish, even when GitHub cancellation is unavailable. */ }
}
