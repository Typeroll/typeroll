// Public-API management of API keys:
//   /api/v1/sites/{siteId}/api-keys[/{prefix}]   — site-scoped keys
//   /api/v1/organization/api-keys[/{prefix}]     — org-scoped keys
// Same rules as the settings UI, and a key can never mint a key that reaches
// further than it does.

import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { SiteShare } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'owner-org';
const OTHER = 'partner-org';
const SITE = 'main-site';
const SECOND = 'second-site';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  for (const id of [SITE, SECOND]) await getStore().setDoc(paths.site(ORG, id), { name: id, created_at: '2026-01-01' });
});

async function key(orgId: string, siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId, siteId, name: 'seed', createdBy: 'person@example.test' })).token;
}

async function share(siteId: string, permission: SiteShare['permission']): Promise<void> {
  const { writeShare } = await import('../../lib/shares');
  await writeShare({ id: `share-${permission}`, site_id: siteId, owner_org_id: ORG, shared_with_org_id: OTHER, permission, created_at: Date.now(), created_by: 'person' });
}

type Method = 'GET' | 'POST' | 'DELETE';
async function call(route: string, method: Method, token: string | null, params: Record<string, string>, body?: unknown) {
  const mod = (route === 'site'
    ? await import('../../pages/api/v1/sites/[siteId]/api-keys/index')
    : route === 'site-key'
      ? await import('../../pages/api/v1/sites/[siteId]/api-keys/[prefix]')
      : route === 'org'
        ? await import('../../pages/api/v1/organization/api-keys/index')
        : await import('../../pages/api/v1/organization/api-keys/[prefix]')) as Record<string, APIRoute>;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await mod[method]!({
    request: new Request('https://portal.test/api/v1/x', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    params, url: new URL('https://portal.test/api/v1/x'),
  } as never) as Response;
  return { status: res.status, json: await res.json().catch(() => ({})) as any, headers: res.headers };
}

describe('site-scoped key management', () => {
  it('lets a site key list, create and revoke keys for its own site only', async () => {
    const token = await key(ORG, SITE);
    const created = await call('site', 'POST', token, { siteId: SITE }, { name: 'CI deploy' });
    expect(created.status).toBe(201);
    expect(created.json.token).toMatch(/^typeroll_live_[a-f0-9]{12}_[a-f0-9]{48}$/);
    expect(created.json.key.created_by).toMatch(/^api-key:[a-f0-9]{12}$/);
    expect(created.headers.get('cache-control')).toBe('no-store');

    const { verifyApiToken } = await import('../../lib/api-keys');
    expect(await verifyApiToken(created.json.token)).toMatchObject({ orgId: ORG, siteId: SITE });

    const listed = await call('site', 'GET', token, { siteId: SITE });
    expect(listed.status).toBe(200);
    expect(listed.json.keys.map((k: { name: string }) => k.name).sort()).toEqual(['CI deploy', 'seed']);
    expect(JSON.stringify(listed.json)).not.toContain('key_hash');

    const revoked = await call('site-key', 'DELETE', token, { siteId: SITE, prefix: created.json.key.id });
    expect(revoked.status).toBe(200);
    expect(await verifyApiToken(created.json.token)).toBeNull();

    // Another site of the same organization is out of reach.
    expect((await call('site', 'POST', token, { siteId: SECOND }, { name: 'x' })).status).toBe(401);
    expect((await call('site', 'GET', token, { siteId: SECOND })).status).toBe(401);
  });

  it('refuses organization key management with a site key', async () => {
    const token = await key(ORG, SITE);
    expect((await call('org', 'GET', token, {})).status).toBe(403);
    const created = await call('org', 'POST', token, {}, { name: 'escalate' });
    expect(created.status).toBe(403);
    const { listApiKeys } = await import('../../lib/api-keys');
    expect(await listApiKeys(ORG, null)).toEqual([]);
  });

  it('requires admin on a shared-in site and creates the key in the owning organization', async () => {
    await share(SITE, 'write');
    const partner = await key(OTHER, null);
    expect((await call('site', 'GET', partner, { siteId: SITE })).status).toBe(200);
    expect((await call('site', 'POST', partner, { siteId: SITE }, { name: 'nope' })).status).toBe(403);

    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.share(ORG, SITE, 'share-write'), { permission: 'admin' });
    await getStore().updateDoc(paths.sharesWithOrgEntry(OTHER, 'share-write'), { permission: 'admin' });
    const created = await call('site', 'POST', partner, { siteId: SITE }, { name: 'partner key' });
    expect(created.status).toBe(201);
    const { verifyApiToken } = await import('../../lib/api-keys');
    expect(await verifyApiToken(created.json.token)).toMatchObject({ orgId: ORG, siteId: SITE });
  });

  it('validates names and unknown keys', async () => {
    const token = await key(ORG, SITE);
    expect((await call('site', 'POST', token, { siteId: SITE }, { name: '' })).status).toBe(400);
    expect((await call('site', 'POST', token, { siteId: SITE }, { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await call('site-key', 'DELETE', token, { siteId: SITE, prefix: '../../x' })).status).toBe(404);
    expect((await call('site-key', 'DELETE', token, { siteId: SITE, prefix: 'abcdefabcdef' })).status).toBe(404);
  });
});

describe('organization key management', () => {
  it('lets an organization key list, create and revoke organization keys', async () => {
    const token = await key(ORG, null);
    const created = await call('org', 'POST', token, {}, { name: 'Hosted connector' });
    expect(created.status).toBe(201);
    const { verifyApiToken } = await import('../../lib/api-keys');
    expect(await verifyApiToken(created.json.token)).toMatchObject({ orgId: ORG, siteId: null });

    const listed = await call('org', 'GET', token, {});
    expect(listed.json.keys.map((k: { name: string }) => k.name).sort()).toEqual(['Hosted connector', 'seed']);

    expect((await call('org-key', 'DELETE', token, { prefix: created.json.key.id })).status).toBe(200);
    expect(await verifyApiToken(created.json.token)).toBeNull();
  });

  it('cannot revoke a site key through the organization route', async () => {
    const orgToken = await key(ORG, null);
    const siteToken = await key(ORG, SITE);
    const prefix = siteToken.split('_')[2]!;
    expect((await call('org-key', 'DELETE', orgToken, { prefix })).status).toBe(404);
    const { verifyApiToken } = await import('../../lib/api-keys');
    expect(await verifyApiToken(siteToken)).not.toBeNull();
    // ...but it can through the site route, as an admin of that site.
    expect((await call('site-key', 'DELETE', orgToken, { siteId: SITE, prefix })).status).toBe(200);
    expect(await verifyApiToken(siteToken)).toBeNull();
  });

  it('401 without a bearer token', async () => {
    expect((await call('org', 'GET', null, {})).status).toBe(401);
  });
});
