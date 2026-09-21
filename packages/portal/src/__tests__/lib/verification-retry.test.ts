import { beforeEach, expect, it } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { retryPublicationVerification, assertVerificationRetry } from '../../lib/publishing/verification-retry';
const path = paths.deploy('org', 'site', 'job');
const publication = { publication_id: 'a'.repeat(64), commit: 'b'.repeat(40), build_task_key: 'build', verification_task_key: 'verify', static_checks_key: 'full', probe_checks_key: 'probes', project_prepared: true, public_media_prepared: true, traffic_applied: true, candidate_verified_id: 'deployment', deployment_id: 'deployment', content_cutoff: '2026-09-21T01:00:00Z', deployment_receipt: { id: 'deployment', uses_functions: false, latest_stage: { name: 'deploy', status: 'success' } } };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  const store = getStore();
  await store.setDoc(paths.site('org', 'site'), { publishing_mode: 'customer_git' });
  await store.setDoc(path, { version_id: 'main', status: 'failed', failure: { code: 'publication_observation_timeout' }, started_at: '2026-09-21T01:00:00Z', git_publication: publication });
  for (const key of ['build', 'verify']) await store.setDoc(`organizations/org/build_tasks/${key}`, { status: 'completed', identity: { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'job', publication_id: publication.publication_id, commit: publication.commit } });
});
it('atomically records the continuation, original failure and a fresh observation window', async () => {
  const store = getStore();
  const results = await Promise.allSettled([retryPublicationVerification('org', 'site', 'job', 'main'), retryPublicationVerification('org', 'site', 'job', 'main')]);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  const job = await store.getDoc<any>(path), token = job.continuation.token;
  expect(job).toMatchObject({ status: 'running', started_at: '2026-09-21T01:00:00Z', git_publication: publication, continuation: { reason: 'retry_public_verification', attempt: 0 } });
  expect(job.continuation.due_at).toBeGreaterThan(0);
  expect(job.verification_retry.request_id).toBe(token);
  expect(Date.parse(job.observation_started_at)).toBeGreaterThan(Date.parse(job.started_at));
  await retryPublicationVerification('org', 'site', 'job', 'main');
  expect((await store.getDoc<any>(path)).continuation.token).toBe(token);
  expect(await store.listDocs(paths.deploys('org', 'site'))).toHaveLength(1);
});
it.each(['build_task_key', 'verification_task_key', 'probe_checks_key', 'static_checks_key', 'project_prepared', 'traffic_applied', 'candidate_verified_id', 'deployment_receipt'])('rejects missing %s without changing the failed job', async field => {
  await getStore().updateDoc(path, { git_publication: { ...publication, [field]: null } });
  await expect(retryPublicationVerification('org', 'site', 'job', 'main')).rejects.toMatchObject({ code: 'verification_retry_unavailable' });
  expect((await getStore().getDoc<any>(path)).status).toBe('failed');
});
it('rejects other failures, versions, deployments and incomplete or mismatched tasks', async () => {
  await expect(retryPublicationVerification('org', 'site', 'job', 'draft')).rejects.toMatchObject({ status: 404 });
  await expect(retryPublicationVerification('other', 'site', 'job', 'main')).rejects.toMatchObject({ status: 404 });
  await getStore().updateDoc(path, { failure: { code: 'customer_build_failed' } });
  await expect(retryPublicationVerification('org', 'site', 'job', 'main')).rejects.toMatchObject({ code: 'verification_retry_unavailable' });
  await getStore().updateDoc(path, { failure: { code: 'publication_observation_timeout' } });
  for (const patch of [{ status: 'cancelled' }, { status: 'completed', identity: { job_id: 'other' } }]) {
    await getStore().updateDoc('organizations/org/build_tasks/build', patch);
    await expect(retryPublicationVerification('org', 'site', 'job', 'main')).rejects.toMatchObject({ code: 'verification_retry_unavailable' });
  }
});
it('rejects a superseded publication both at admission and during execution', async () => {
  await retryPublicationVerification('org', 'site', 'job', 'main');
  await getStore().setDoc(paths.deploy('org', 'site', 'newer'), { version_id: 'main', status: 'succeeded', started_at: '2026-09-21T02:00:00Z' });
  await expect(assertVerificationRetry('org', 'site', (await getStore().getDoc<any>(path)), true)).rejects.toMatchObject({ code: 'verification_retry_unavailable' });
});

it('cannot reinterpret a verification retry as a build after the publishing mode changes', async () => {
  await retryPublicationVerification('org', 'site', 'job', 'main');
  await getStore().updateDoc(paths.site('org', 'site'), { publishing_mode: 'managed' });
  await expect(assertVerificationRetry('org', 'site', (await getStore().getDoc<any>(path)), true)).rejects.toMatchObject({ code: 'verification_retry_unavailable' });
});
