import { beforeEach, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import { GET } from '../../pages/api/v1/sites/[siteId]/composition-starters';
let token: string;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Example' });
  await getStore().setDoc(paths.version('org', 'site', MAIN_VERSION_ID), { name: 'Main', kind: 'main' });
  const { createApiKey } = await import('../../lib/api-keys');
  ({ token } = await createApiKey({ orgId: 'org', siteId: 'site', name: 'test', createdBy: 'admin' }));
});
const call = (query: string, key = token) => GET({ params: { siteId: 'site' }, request: new Request(`http://localhost/api/v1/sites/site/composition-starters?${query}`, { headers: { authorization: `Bearer ${key}` } }) } as never) as Promise<Response>;
it('returns editable native starters through real site-scoped authentication without storing templates', async () => {
  for (const kind of ['header', 'footer', 'profile', 'landing', 'article']) {
    const res = await call(`kind=${kind}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind, saved: false });
    expect(body.blocks[0].type).toBe('core/section');
  }
  const { vstore } = await import('../../lib/version-store');
  expect(await vstore.pageTemplates('org', 'site', MAIN_VERSION_ID)).toHaveLength(0);
});
it('rejects missing archive type, unknown starter and invalid credentials', async () => {
  expect((await call('kind=archive')).status).toBe(400);
  expect((await call('kind=unknown')).status).toBe(400);
  expect((await call('kind=header', 'invalid')).status).toBe(401);
  const res = await call('kind=archive&content_type=articles&title=Guides');
  expect(res.status).toBe(200);
  expect(JSON.stringify(await res.json())).toContain('"content_type":"articles"');
});
