import { beforeEach, expect, it } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { buildTasksPath } from '../../lib/builds/queue';
import { buildInputPath } from '../../lib/builds/state';
import { activeBuilds } from '../../lib/builds/activity';

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
