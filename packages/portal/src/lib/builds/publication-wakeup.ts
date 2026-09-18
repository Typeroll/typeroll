import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import type { GitJob } from '../publishing/customer-runner';
import { buildTasksPath, type BuildTask } from './queue';
import type { BuildInput } from './state';

/** An authenticated runner completion wakes only its still-current frozen publication. */
export async function wakeCompletedPublication(org: string, key: string, kind: BuildInput['kind']) {
  if (kind !== 'publication' && kind !== 'static_verification') return;
  const task = await getStore().getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  if (!task || task.status !== 'completed' || task.identity.org_id !== org) return;
  const identity = task.identity;
  const job = await getStore().getDoc<GitJob>(paths.deploy(org, identity.site_id, identity.job_id));
  const publication = job?.git_publication;
  const reference = kind === 'publication' ? publication?.build_task_key : publication?.verification_task_key;
  if (!job || !['queued', 'running'].includes(job.status) || job.dry_run ||
      job.version_id !== identity.version_id || reference !== key ||
      publication?.publication_id !== identity.publication_id || publication.commit !== identity.commit) return;
  const dispatchKey = createHash('sha256').update(`completed:${key}`).digest('hex').slice(0, 16);
  const { getDeployQueue } = await import('../deploy/queue');
  await getDeployQueue().enqueue({ orgId: org, siteId: identity.site_id, jobId: identity.job_id,
    versionId: identity.version_id, environment: job.environment, dispatchKey, delayMs: 0 });
  console.info(JSON.stringify({ event: 'publication_completion_wakeup', job_id: identity.job_id, kind }));
}
