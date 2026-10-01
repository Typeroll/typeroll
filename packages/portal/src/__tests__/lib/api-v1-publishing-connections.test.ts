// Public-API organization publishing connections:
//   GET    /api/v1/publishing/connections
//   POST   /api/v1/publishing/connections/cloudflare   (browserless steps)
//   DELETE /api/v1/publishing/connections/{provider}
// Organization keys only, as the portal Publishing page is for organization
// owners and admins. OAuth sign-in stays in the browser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'owner-org';
const SITE = 'main-site';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://portal.test');
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'Main', created_at: '2026-01-01' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function key(siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId: ORG, siteId, name: 'seed', createdBy: 'person@example.test' })).token;
}

async function call(method: string, token: string, params: Record<string, string>, body?: unknown) {
  const mod = (params.provider
    ? await import('../../pages/api/v1/publishing/connections/[provider]')
    : await import('../../pages/api/v1/publishing/connections/index')) as Record<string, APIRoute>;
  const res = await mod[method]!({
    request: new Request('https://portal.test/api/v1/publishing/connections', {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params,
  } as never) as Response;
  return { status: res.status, json: await res.json().catch(() => ({})) as any, headers: res.headers };
}

describe('organization publishing connections through the public API', () => {
  it('reads status and connect URLs without exposing credentials', async () => {
    const { getConnection, saveConnection, sealCredentials } = await import('../../lib/publishing/connections');
    const current = await getConnection(ORG, 'github');
    await saveConnection(ORG, 'github', current.revision, {
      status: 'connected', github: { app_id: '1', installation_id: '2', account_id: '3', owner: 'synthetic-owner' },
      encrypted_credentials: sealCredentials(ORG, 'github', { token: 'synthetic-secret-token' }),
    });
    const res = await call('GET', await key(null), {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.json.github).toMatchObject({ status: 'connected', github: { owner: 'synthetic-owner' } });
    expect(res.json.cloudflare.status).toBe('disconnected');
    expect(res.json.connect_urls).toEqual({
      github: 'https://portal.test/app/settings/publishing#github',
      cloudflare: 'https://portal.test/app/settings/publishing#cloudflare',
    });
    expect(JSON.stringify(res.json)).not.toContain('synthetic-secret-token');
    expect(JSON.stringify(res.json)).not.toContain('encrypted_credentials');
  });

  it('refuses site-scoped keys, as the portal refuses site administrators', async () => {
    const siteKey = await key(SITE);
    expect((await call('GET', siteKey, {})).status).toBe(403);
    expect((await call('DELETE', siteKey, { provider: 'github' }, { revision: 'x' })).status).toBe(403);
    expect((await call('POST', siteKey, { provider: 'cloudflare' }, { action: 'prepare_media', revision: 'x' })).status).toBe(403);
  });

  it('disconnects only at the current revision', async () => {
    const { getConnection, saveConnection } = await import('../../lib/publishing/connections');
    const current = await getConnection(ORG, 'github');
    await saveConnection(ORG, 'github', current.revision, { status: 'connected' });
    const token = await key(null);
    expect((await call('DELETE', token, { provider: 'github' }, { revision: current.revision })).status).toBe(409);
    const latest = await getConnection(ORG, 'github');
    const res = await call('DELETE', token, { provider: 'github' }, { revision: latest.revision });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ disconnected: true });
    expect((await getConnection(ORG, 'github')).status).toBe('disconnected');
    expect((await call('DELETE', token, { provider: 'gitlab' }, { revision: 'x' })).status).toBe(404);
  });

  it('points browser-only steps at the portal and validates Cloudflare actions', async () => {
    const token = await key(null);
    const github = await call('POST', token, { provider: 'github' }, {});
    expect(github.status).toBe(409);
    expect(github.json.error).toContain('https://portal.test/app/settings/publishing#github');
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'start' })).status).toBe(400);
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'connect', revision: 'x' })).status).toBe(400);
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'prepare_media', revision: 'x' })).status).toBe(409);
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'connect', hosting_group_id: 'eu' })).status).toBe(400);
  });

  it('connects Cloudflare with a customer API token and records the key as the actor', async () => {
    const accountId = 'a'.repeat(32);
    const cloudflare = await import('../../lib/publishing/cloudflare-connection');
    const spy = vi.spyOn(cloudflare, 'connectCloudflare').mockResolvedValue(undefined);
    const token = await key(null);
    const body = { action: 'connect', revision: 'r', account_id: accountId, bucket: 'media', api_token: 't', access_key_id: 'a', secret_access_key: 's' };
    const res = await call('POST', token, { provider: 'cloudflare' }, body);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ connected: true });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, userId: expect.stringMatching(/^api-key:[a-f0-9]{12}$/) }), body);
  });
});
