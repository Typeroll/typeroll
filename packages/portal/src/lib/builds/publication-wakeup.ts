import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import type { GitJob } from '../publishing/customer-runner';
import { buildTasksPath, type BuildTask } from './queue';
import type { BuildInput } from './state';

/** An authenticated runner completion wakes only its still-current frozen publication. */
export async function wakeCompletedPublication(org: string, key: string, kind: BuildInput['kind'], attempt = 0): Promise<void> {
  if (kind !== 'publication' && kind !== 'static_verification') return;
  const task = await getStore().getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  if (!task || !['completed', 'failed', 'cancelled'].includes(task.status) || task.identity.org_id !== org) return;
  const identity = task.identity;
  const job = await getStore().getDoc<GitJob>(paths.deploy(org, identity.site_id, identity.job_id));
  const publication = job?.git_publication;
  const reference = kind === 'publication' ? publication?.build_task_key : publication?.verification_task_key;
  if (!job || !['queued', 'running'].includes(job.status) || job.dry_run ||
      job.version_id !== identity.version_id || reference !== key ||
      publication?.publication_id !== identity.publication_id || publication.commit !== identity.commit) return;
  const token = `result:${key}`;
  if ((job as any).completion_signals?.[key]) return;
  const won = await getStore().compareAndReplaceDoc(paths.deploy(org, identity.site_id, identity.job_id), job, {
    ...job, completion_signals: { ...(job as any).completion_signals, [key]: true },
    continuation: { token, reason: 'build_result', due_at: Date.now(), attempt: 0 },
  });
  if (!won) {
    if (attempt >= 3) throw new Error('Concurrent publication update; retry completion delivery');
    return wakeCompletedPublication(org, key, kind, attempt + 1);
  }
  console.info(JSON.stringify({ event: 'publication_completion_wakeup', job_id: identity.job_id, kind }));
}
