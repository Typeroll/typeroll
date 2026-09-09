import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
const access = vi.hoisted(() => vi.fn());
vi.mock('../../lib/access', () => ({ requireSiteAccess: access, json: (body: unknown) => Response.json(body), requirePermission: vi.fn() }));
vi.mock('../../lib/deploy/availability', () => ({ refreshDeploymentAvailability: async (_org: string, _site: string, job: unknown) => job }));
import { GET } from '../../pages/api/sites/[siteId]/deploy';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  access.mockResolvedValue({ ok: true, value: { owner_org_id: 'org', site: { id: 'site' }, versionId: 'design' } });
});
afterEach(() => vi.restoreAllMocks());
it('returns the latest job for the selected version without substituting another version failure', async () => {
  const store = getStore();
  await store.setDoc(paths.deploy('org', 'site', 'main-failure'), { version_id: 'main', status: 'failed', started_at: '2026-09-09T09:00:00Z', error: 'Main failure' });
  await store.setDoc(paths.deploy('org', 'site', 'design-failure'), { version_id: 'design', status: 'failed', started_at: '2026-09-09T08:00:00Z', error: 'Design failure' });
  for (let i = 0; i < 25; i++) await store.setDoc(paths.deploy('org', 'site', `other-${i}`), { version_id: 'other', status: 'succeeded', started_at: '2026-09-09T10:00:00Z' });
  const response = await GET({ cookies: {}, params: { siteId: 'site' }, locals: {} } as any);
  const body = await response.json();
  expect(body.active_job).toBeNull();
  expect(body.latest_job).toMatchObject({ id: 'design-failure', error: 'Design failure' });
});
it('keeps deployment observations behind the existing site authorization boundary', async () => {
  access.mockResolvedValue({ ok: false, response: new Response(null, { status: 404 }) });
  const response = await GET({ cookies: {}, params: { siteId: 'site' }, locals: {} } as any);
  expect(response.status).toBe(404);
});
