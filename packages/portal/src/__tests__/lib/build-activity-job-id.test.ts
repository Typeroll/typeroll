import { beforeEach, expect, it } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { buildTasksPath } from '../../lib/builds/queue';
import { buildInputPath } from '../../lib/builds/state';
import { activeBuilds, buildActivity } from '../../lib/builds/activity';

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('lists the job id of each active build, so a media preparation job can be matched', async () => {
  const store = getStore();
  await store.setDoc(paths.site('org', 'site'), { name: 'Site' });
  const key = 'a'.repeat(64);
  await store.setDoc(`${buildTasksPath('org')}/${key}`, { identity: { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'media-123' }, status: 'running', attempt: 1, media_total: 4, media_cursor: 1 });
  await store.setDoc(buildInputPath('org', key), { kind: 'media_preparation', provider: 'cloudflare' });
  await store.setDoc(`${buildTasksPath('org')}/${'b'.repeat(64)}`, { identity: { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'done' }, status: 'completed', attempt: 1 });
  expect(await activeBuilds('org')).toEqual([expect.objectContaining({ key, job_id: 'media-123', site_id: 'site', kind: 'media_preparation', status: 'running', media_preparation: { completed: 1, total: 4 } })]);
});

it('keeps a publication listed after its build until its deploy reaches a final status', async () => {
  const store = getStore(), now = Date.now();
  await store.setDoc(paths.site('org', 'site'), { name: 'Site' });
  const publishing = 'c'.repeat(64), published = 'd'.repeat(64), media = 'e'.repeat(64);
  const task = (job_id: string) => ({ identity: { org_id: 'org', site_id: 'site', version_id: 'main', job_id }, status: 'completed', completed_at: now - 20_000, attempt: 1 });
  await store.setDoc(`${buildTasksPath('org')}/${publishing}`, task('job-uploading'));
  await store.setDoc(buildInputPath('org', publishing), { kind: 'publication', provider: 'cloudflare' });
  await store.setDoc(paths.deploy('org', 'site', 'job-uploading'), { status: 'running', phase: 'verifying' });
  await store.setDoc(`${buildTasksPath('org')}/${published}`, task('job-done'));
  await store.setDoc(buildInputPath('org', published), { kind: 'publication', provider: 'cloudflare' });
  await store.setDoc(paths.deploy('org', 'site', 'job-done'), { status: 'succeeded' });
  await store.setDoc(`${buildTasksPath('org')}/${media}`, task('media-1'));
  await store.setDoc(buildInputPath('org', media), { kind: 'media_preparation', provider: 'cloudflare' });
  expect(await activeBuilds('org', now)).toEqual([expect.objectContaining({ key: publishing, job_id: 'job-uploading', status: 'publishing', phase: 'verifying', kind: 'publication' })]);
  await store.updateDoc(paths.deploy('org', 'site', 'job-uploading'), { status: 'succeeded' });
  expect(await activeBuilds('org', now)).toEqual([]);
});

it('lists a domain switch that only waits for DNS approval apart from active jobs', async () => {
  const store = getStore(), now = Date.now();
  await store.setDoc(paths.site('org', 'fi'), { name: 'Finland' });
  const key = 'f'.repeat(64);
  await store.setDoc(`${buildTasksPath('org')}/${key}`, { identity: { org_id: 'org', site_id: 'fi', version_id: 'main', job_id: 'switch-1' }, status: 'completed', completed_at: now - 60_000, attempt: 1 });
  await store.setDoc(buildInputPath('org', key), { kind: 'publication', provider: 'cloudflare' });
  await store.setDoc(paths.deploy('org', 'fi', 'switch-1'), { status: 'running', phase: 'awaiting domain cutover approval' });
  expect(await activeBuilds('org', now)).toEqual([]);
  expect(await buildActivity('org', now)).toEqual({ active_jobs: [], awaiting_approval: [expect.objectContaining({ key, job_id: 'switch-1', site_id: 'fi', site_name: 'Finland', status: 'awaiting_approval' })] });
});
