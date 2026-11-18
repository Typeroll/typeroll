import type { DeployProgress } from './useDeployProgress';

export function canRetryVerification(job: DeployProgress | null) {
  if (job?.status !== 'failed') return false;
  if (['publication_observation_timeout', 'publication_cache_refresh_required', 'publication_cache_refresh_external', 'publication_cache_refresh_failed'].includes(job.failure?.code ?? '')) return true;
  return job.serving?.state === 'live_unverified' && ['shared_runner_start_failed', 'github_build_attempts_exhausted', 'build_queue_timeout', 'shared_build_timeout', 'build_connection_lost', 'verification_static_verification_pending'].includes(job.failure?.code ?? '');
}
