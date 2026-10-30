import { beforeEach, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'orgone', SITE = 'mysite';
let token = '';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { paths } = await import('@typeroll/shared');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() });
  const { createApiKey } = await import('../../lib/api-keys');
  token = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'site', createdBy: 'admin@example.com' })).token;
});
async function call(method: 'PUT' | 'PATCH', body: unknown) {
  const route = await import('../../pages/api/v1/sites/[siteId]/apps/[appId]') as Record<string, APIRoute>;
  const request = new Request(`http://localhost/api/v1/sites/${SITE}/apps/integrations`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return route[method]({ request, params: { siteId: SITE, appId: 'integrations' }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

it('PATCH updates integration config without turning the app off', async () => {
  const { getAppDef } = await import('../../lib/apps/registry');
  const [first, second] = getAppDef('integrations')!.fields.map(field => field.key);
  expect((await call('PUT', { enabled: true, config: { [first]: 'first-id' } })).status).toBe(200);
  const res = await call('PATCH', { config: { [second]: 'second-id' } });
  expect(res.status).toBe(200);
  const body = await res.json() as { state: { enabled: boolean; config: Record<string, unknown> } };
  expect(body.state.enabled).toBe(true);
  expect(body.state.config).toMatchObject({ [first]: 'first-id', [second]: 'second-id' });
  expect((await call('PATCH', { enabled: 'yes' })).status).toBe(400);
  expect((await (await call('PATCH', { enabled: false })).json() as { state: { enabled: boolean } }).state.enabled).toBe(false);
});
