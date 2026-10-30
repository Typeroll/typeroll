import { beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const read = vi.hoisted(() => vi.fn(async () => 'https://signed.example/object?sig=1'));
vi.mock('../../lib/publishing/media-storage', () => ({ privateMediaReadUrl: read }));
const ORG = 'orgone', SITE = 'mysite';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); read.mockClear();
  const { getStore } = await import('../../lib/datastore');
  const { paths } = await import('@typeroll/shared');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() });
});
async function get(headers: Record<string, string>) {
  const route = await import('../../pages/api/sites/[siteId]/media/[mediaId]/content');
  const request = new Request(`http://localhost/api/sites/${SITE}/media/logo/content`, { headers });
  return route.GET({ request, params: { siteId: SITE, mediaId: 'logo' }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

it('lets an organization API key follow a private media cdn_url', async () => {
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: null, name: 'org', createdBy: 'admin@example.com' } as never);
  const res = await get({ authorization: `Bearer ${token}` });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('https://signed.example/object?sig=1');
  expect(read).toHaveBeenCalledWith(ORG, SITE, 'logo');
  expect((await get({ authorization: 'Bearer tr_invalid' })).status).toBe(401);
  expect(read).toHaveBeenCalledTimes(1);
});
