import { paths, type DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { buildTasksPath, type BuildTask } from './queue';
import { buildInputPath, readEngineConfiguration, type BuildInput } from './state';
import { cloudflareClient } from '../publishing/cloudflare-oauth';
import { githubBuildClient, readGithubDispatch } from './github';

/** Report a revoked execution on demand; never dispatch a replacement build. */
export async function refreshBuildFailure(org: string, site: string, job: DeployJob): Promise<DeployJob> {
  if (!['queued', 'running'].includes(job.status)) return job;
  const publication = (job as any).git_publication;
  const key = publication?.verification_task_key ?? publication?.build_task_key;
  if (!key) return job;
  const store = getStore(), taskPath = `${buildTasksPath(org)}/${key}`;
  let task = await store.getDoc<BuildTask>(taskPath);
  if (!task || task.identity.org_id !== org || task.identity.site_id !== site || task.identity.job_id !== job.id) return job;
  const now = Date.now();
  // A running attempt whose heartbeat lease expired cannot authorize another
  // upload or result. Surface that loss; elapsed build duration is irrelevant.
  if (task.status === 'running' && task.lease_until <= now) {
    await store.compareAndUpdateDoc<BuildTask>(taskPath, current => current.status === 'running' && current.lease_id === task!.lease_id && current.lease_until <= now,
      { status: 'failed', token_hash: null, error_code: 'build_connection_lost', completed_at: now });
    task = await store.getDoc<BuildTask>(taskPath);
  }
  if (task?.status === 'queued' && task.attempt === 0) {
    // This read is requested by the editor/API caller, not a background timer.
    // A provider run may fail before it can claim work or send a callback.
    try {
      const input = await store.getDoc<BuildInput>(buildInputPath(org, key));
      const engine = input && await readEngineConfiguration(org, input.provider ?? 'cloudflare');
      if (input && engine && engine.revision === task.engine_revision && (input.dispatch_id || input.dispatch_uncertain)) {
        const stopped = input.provider === 'github'
          ? (await readGithubDispatch(await githubBuildClient(engine), engine, input))?.status === 'completed'
          : input.dispatch_id && (await (await cloudflareClient(org))(`/accounts/${engine.account_id}/builds/builds/${input.dispatch_id}`))?.status === 'stopped';
        if (stopped) {
          await store.compareAndUpdateDoc<BuildTask>(taskPath, current => current.status === 'queued' && current.attempt === task!.attempt,
            { status: 'failed', token_hash: null, error_code: 'build_result_missing', completed_at: now });
          task = await store.getDoc<BuildTask>(taskPath);
        }
      }
    } catch { /* An unavailable provider is not evidence that a build failed. */ }
  }
  if (!task || !['failed', 'cancelled'].includes(task.status)) return job;
  const code = task.error_code ?? 'shared_build_failed';
  const patch = { status: 'failed', finished_at: new Date(now).toISOString(),
    error: code === 'build_connection_lost'
      ? 'The build engine stopped reporting progress and this attempt can no longer finish. Check the build log, then retry publishing. No replacement build was started.'
      : 'The build engine reported a failed or cancelled attempt. Check the build log, then retry publishing.',
    failure: { stage: job.phase ?? 'building', code } };
  await store.compareAndUpdateDoc<any>(paths.deploy(org, site, job.id), current => ['queued', 'running'].includes(current.status) &&
    (current.git_publication?.verification_task_key ?? current.git_publication?.build_task_key) === key, patch);
  return (await store.getDoc<DeployJob>(paths.deploy(org, site, job.id))) ?? job;
}
