import type { DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { buildTasksPath, type BuildTask } from './queue';

/** Read the exact task, never expose tokens or other sites' organization activity. */
export async function publicationBuildProgress(org: string, site: string, job: DeployJob) {
  const publication = (job as DeployJob & { git_publication?: { verification_task_key?: string; build_task_key?: string } }).git_publication;
  const key = publication?.verification_task_key ?? publication?.build_task_key;
  if (!key || !/^[a-f0-9]{64}$/.test(key)) return null;
  const task = await getStore().getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  if (!task || task.identity.org_id !== org || task.identity.site_id !== site || task.identity.job_id !== job.id || task.identity.version_id !== job.version_id) return null;
  return { status: task.status, attempt: task.attempt,
    step: publication?.verification_task_key ? 'verifying_static_files' : task.media_total && (task.media_cursor ?? 0) < task.media_total ? 'preparing_media' : 'building_site',
    completed: task.media_cursor ?? 0, total: task.media_total ?? 0 };
}
