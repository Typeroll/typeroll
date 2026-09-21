import { randomUUID } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { buildTasksPath, type BuildTask } from '../builds/queue';
import { ConnectionError } from './connections';
import type { GitJob } from './customer-runner';

const unavailable = () => new ConnectionError('This deployment cannot resume verification. A finished, already-served publication with unchanged hosting is required.', 409, 'verification_retry_unavailable');

/** No source, build, upload or DNS operation is authorized by this recovery. */
export async function assertVerificationRetry(org: string, site: string, job: GitJob, resumed = false) {
  const publication = job.git_publication;
  const failure = resumed ? job.verification_retry?.failure : job.failure;
  if (job.status !== (resumed ? 'running' : 'failed') || job.dry_run || failure?.code !== 'publication_observation_timeout' ||
      !publication?.publication_id || !/^[a-f0-9]{64}$/.test(publication.publication_id) ||
      !publication.commit || !/^[a-f0-9]{40}$/.test(publication.commit) || publication.release_branch ||
      !publication.build_task_key || !publication.verification_task_key || !publication.static_checks_key || !publication.probe_checks_key ||
      !publication.project_prepared || !publication.public_media_prepared || !publication.traffic_applied ||
      !publication.candidate_verified_id || publication.candidate_verified_id !== publication.deployment_id ||
      publication.deployment_receipt?.id !== publication.deployment_id || publication.deployment_receipt?.uses_functions !== false ||
      publication.deployment_receipt?.latest_stage?.status !== 'success' || publication.deployment_receipt?.latest_stage?.name !== 'deploy') throw unavailable();
  const store = getStore();
  const currentSite = await store.getDoc<{ publishing_mode?: string }>(paths.site(org, site));
  if (currentSite?.publishing_mode !== 'customer_git') throw unavailable();
  const jobs = await store.listDocs<GitJob>(paths.deploys(org, site));
  if (jobs.some(other => other.id !== job.id && other.version_id === job.version_id &&
      (other.started_at >= job.started_at || ['queued', 'running'].includes(other.status)))) throw unavailable();
  const target = await store.getDoc<any>(`${paths.site(org, site)}/publishing_targets/${job.version_id}`);
  if (target?.last_publication && target.last_publication.content_cutoff > publication.content_cutoff) throw unavailable();
  if (target?.job_id && target.job_id !== job.id && target.lease_until > Date.now()) throw unavailable();
  for (const key of [publication.build_task_key, publication.verification_task_key]) {
    const task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
    if (!task || task.status !== 'completed' || task.identity.job_id !== job.id || task.identity.org_id !== org ||
        task.identity.site_id !== site || task.identity.version_id !== job.version_id ||
        task.identity.publication_id !== publication.publication_id || task.identity.commit !== publication.commit) throw unavailable();
  }
}

/** Saving the continuation with the state transition is the durable enqueue. */
export async function retryPublicationVerification(org: string, site: string, jobId: string, version: string) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(jobId)) throw new ConnectionError('Invalid deployment ID.', 400);
  const store = getStore(), path = paths.deploy(org, site, jobId);
  const job = await store.getDoc<GitJob>(path);
  if (!job || job.version_id !== version) throw new ConnectionError('Deployment not found in this version.', 404);
  if (job.status === 'running' && job.verification_retry) return { job_id: jobId, already_running: true };
  await assertVerificationRetry(org, site, job);
  const now = new Date().toISOString(), token = randomUUID();
  const saved = await store.compareAndReplaceDoc(path, job, {
    ...job, status: 'running', phase: 'retrying public verification', observation_started_at: now,
    finished_at: null, error: null, failure: null, coordinator_retries: 0,
    verification_retry: { request_id: token, requested_at: now, failure: job.failure },
    continuation: { token, reason: 'retry_public_verification', due_at: Date.now(), attempt: 0 },
  });
  if (!saved) throw new ConnectionError('Deployment state changed. Read its status before retrying.', 409, 'verification_retry_conflict');
  return { job_id: jobId, verification_only: true, publication_id: job.git_publication!.publication_id };
}
