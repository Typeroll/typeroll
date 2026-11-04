// Turnstile in the portal: site admins save, read and remove the keys through
// the cookie route; the secret is never returned and editors are refused.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'default';
const SITE = 'mysite';
const SITE_KEY = '0x4AAAAAAAportalsitekey';
const SECRET = '0x4AAAAAAAportalsecret000000';
const auth = vi.hoisted(() => ({ permission: 'admin' as string }));

vi.mock('../../lib/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/access')>();
  return {
    ...actual,
    requireSiteAccess: async (...args: Parameters<typeof actual.requireSiteAccess>) => {
      const result = await actual.requireSiteAccess(...args);
      return result.ok ? { ok: true, value: { ...result.value, permission: auth.permission } } : result;
    },
  };
});

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.INTEGRATIONS_SECRET_KEY = 'k'.repeat(48);
  auth.permission = 'admin';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  // Cloudflare accepts the secret: a dummy answer is only reported as invalid.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

async function call(method: 'GET' | 'PUT' | 'DELETE', body?: unknown): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/form-spam-protection');
  return mod[method]({
    request: new Request(`http://localhost/api/sites/${SITE}/form-spam-protection`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    cookies: { get: () => undefined }, params: { siteId: SITE }, locals: {},
  } as never) as Promise<Response>;
}

it('lets a site admin save, keep and remove Turnstile keys without exposing the secret', async () => {
  const saved = await call('PUT', { provider: 'turnstile', site_key: SITE_KEY, secret_key: SECRET });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const text = await saved.text();
  expect(text).not.toContain(SECRET);
  expect(JSON.parse(text)).toMatchObject({ provider: 'turnstile', site_key: SITE_KEY, secret_key: { set: true } });
  // Saving the same site key without a secret keeps the stored one.
  expect((await call('PUT', { provider: 'turnstile', site_key: SITE_KEY })).status).toBe(200);
  expect(await (await call('GET')).json()).toMatchObject({ site_key: SITE_KEY, secret_key: { set: true } });
  expect(await (await call('DELETE')).json()).toMatchObject({ provider: null, site_key: null });
});

it('refuses editors', async () => {
  auth.permission = 'write';
  expect((await call('GET')).status).toBe(403);
  expect((await call('PUT', { provider: 'turnstile', site_key: SITE_KEY, secret_key: SECRET })).status).toBe(403);
});
