// The portal no longer transcodes images: generate-variants reports that the
// build engine produces them, and never touches storage.
import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';

vi.mock('../../lib/api-auth', async (load) => ({
  ...await load<object>(),
  requireApiKey: async (request: Request) => ({ ok: true, value: { orgId: 'org', siteId: 'site', permission: 'admin', keyPrefix: 'k', request, path: new URL(request.url).pathname } }),
}));
vi.mock('../../lib/net/s3', () => { throw new Error('storage must not be used'); });

const { POST } = await import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/generate-variants');
const call = (mediaId: string) => POST({ request: new Request('https://portal.test/', { method: 'POST' }), params: { siteId: 'site', mediaId } } as never) as Promise<Response>;

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  const media = paths.media('org', 'site');
  await getStore().setDoc(`${media}/legacy`, { filename: 'a.png', mime_type: 'image/png', r2_key: 'sites/x/a.png', cdn_url: 'https://cdn.example/a.png', created_at: '' });
  await getStore().setDoc(`${media}/stored`, { filename: 'b.jpg', mime_type: 'image/jpeg', storage: { provider: 'organization_r2' }, cdn_url: 'https://cdn.example/b.jpg', created_at: '' });
  await getStore().setDoc(`${media}/pdf`, { filename: 'c.pdf', mime_type: 'application/pdf', r2_key: 'sites/x/c.pdf', cdn_url: 'https://cdn.example/c.pdf', created_at: '' });
});

it('reports variants as pending for images and skips other files', async () => {
  expect(await (await call('stored')).json()).toMatchObject({ ok: true, variants_pending: true, message: expect.stringContaining('build machine') });
  expect(await (await call('legacy')).json()).toMatchObject({ ok: true, variants_pending: true, message: expect.stringContaining('organization storage') });
  expect(await (await call('pdf')).json()).toMatchObject({ ok: true, skipped: true });
  expect((await call('missing')).status).toBe(404);
  const legacy = await getStore().getDoc(`${paths.media('org', 'site')}/legacy`);
  expect(legacy).not.toHaveProperty('variants');
});
