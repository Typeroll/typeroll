import type { DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { buildTasksPath, buildAttemptLimit, type BuildTask } from './queue';

/** Read the exact task, never expose tokens or other sites' organization activity. */
export async function publicationBuildProgress(org: string, site: string, job: DeployJob) {
  const publication = (job as DeployJob & { git_publication?: { verification_task_key?: string; build_task_key?: string } }).git_publication;
  const key = publication?.verification_task_key ?? publication?.build_task_key;
  if (!key || !/^[a-f0-9]{64}$/.test(key)) return null;
  const task = await getStore().getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  if (!task || task.identity.org_id !== org || task.identity.site_id !== site || task.identity.job_id !== job.id || task.identity.version_id !== job.version_id) return null;
  // Media preparation runs in windows of about 12 minutes. A window that ends
  // with a saved checkpoint starts the next build run from that position, so
  // `attempt` also counts these planned continuations, not only retries.
  const continuations = Math.min(task.media_batches ?? 0, Math.max(0, task.attempt - 1));
  return { status: task.status, attempt: task.attempt,
    media_continuations: continuations, retries: Math.max(0, task.attempt - 1 - continuations), attempt_limit: buildAttemptLimit(task),
    deadline: Number.isFinite(task.deadline) ? new Date(task.deadline).toISOString() : null,
    step: task.status === 'queued' ? 'waiting_for_runner' : publication?.verification_task_key ? 'verifying_static_files' : task.media_total && (task.media_cursor ?? 0) < task.media_total ? 'preparing_media' : 'building_site',
    queued_since: task.status === 'queued' ? new Date(task.queued_at ?? task.created_at).toISOString() : null,
    retry_behavior: 'A new publication does not automatically cancel this job. Retry only after a terminal failure; a queued timeout revokes the old task before a retry can run.',
    attempt_note: 'attempt counts build runs. Large media sets are prepared in windows of about 12 minutes; each window saves its position and the next run continues from it. media_continuations counts those planned windows; retries counts runs that failed and were started again.',
    completed: task.media_cursor ?? 0, total: task.media_total ?? 0 };
}
