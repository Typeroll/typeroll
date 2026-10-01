// Public-API site sharing (/api/v1/sites/{siteId}/shares[/{shareId}]) and
// organization invites (/api/v1/organization/invites). Same role checks as
// the portal: sharing needs admin on the site; invites act for the
// organization and need an organization key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { SiteShare } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'owner-org';
const PARTNER = 'partner-org';
const CLIENT = 'client-org';
const SITE = 'main-site';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'Main', created_at: '2026-01-01' });
  for (const [id, slug] of [[ORG, 'owner'], [PARTNER, 'partner'], [CLIENT, 'client']]) {
    await getStore().setDoc(paths.org(id), { name: id, slug, plan: 'free', created_at: '2026-01-01' });
  }
});
afterEach(() => { vi.unstubAllEnvs(); });

async function key(orgId: string, siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId, siteId, name: 'seed', createdBy: 'person@example.test' })).token;
}

async function call(route: 'shares' | 'share' | 'invites', method: string, token: string | null, params: Record<string, string>, body?: unknown) {
  const mod = (route === 'shares'
    ? await import('../../pages/api/v1/sites/[siteId]/shares/index')
    : route === 'share'
      ? await import('../../pages/api/v1/sites/[siteId]/shares/[shareId]')
      : await import('../../pages/api/v1/organization/invites')) as Record<string, APIRoute>;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await mod[method]!({
    request: new Request('https://portal.test/api/v1/x', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    params,
  } as never) as Response;
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}

describe('site sharing through the public API', () => {
  it('shares, updates and revokes with an admin key and keeps both records in step', async () => {
    const token = await key(ORG, SITE);
    const created = await call('shares', 'POST', token, { siteId: SITE }, { org_slug: 'client', permission: 'read', label: 'Client' });
    expect(created.status).toBe(201);
    const share = created.json.share as SiteShare;
    expect(share).toMatchObject({ shared_with_org_id: CLIENT, permission: 'read', label: 'Client', owner_org_id: ORG });
    expect(share.created_by).toMatch(/^api-key:/);

    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.sharesWithOrgEntry(CLIENT, share.id))).toBeTruthy();

    expect((await call('shares', 'POST', token, { siteId: SITE }, { org_id: CLIENT })).status).toBe(409);
    expect((await call('shares', 'POST', token, { siteId: SITE }, { org_id: ORG })).status).toBe(400);
    expect((await call('shares', 'POST', token, { siteId: SITE }, { org_id: CLIENT, permission: 'owner' })).status).toBe(400);

    const updated = await call('share', 'PATCH', token, { siteId: SITE, shareId: share.id }, { permission: 'write' });
    expect(updated.status).toBe(200);
    expect(updated.json.share.permission).toBe('write');
    expect(await getStore().getDoc<SiteShare>(paths.sharesWithOrgEntry(CLIENT, share.id))).toMatchObject({ permission: 'write' });

    const listed = await call('shares', 'GET', token, { siteId: SITE });
    expect(listed.json.shares).toHaveLength(1);

    expect((await call('share', 'DELETE', token, { siteId: SITE, shareId: share.id })).status).toBe(200);
    expect(await getStore().getDoc(paths.sharesWithOrgEntry(CLIENT, share.id))).toBeNull();
    expect((await call('share', 'PATCH', token, { siteId: SITE, shareId: share.id }, { label: 'x' })).status).toBe(404);
  });

  it('requires admin on the site, as the portal does', async () => {
    const { writeShare } = await import('../../lib/shares');
    await writeShare({ id: 'partner-share', site_id: SITE, owner_org_id: ORG, shared_with_org_id: PARTNER, permission: 'write', created_at: Date.now(), created_by: 'person' });
    const partner = await key(PARTNER, null);
    expect((await call('shares', 'GET', partner, { siteId: SITE })).status).toBe(403);
    expect((await call('shares', 'POST', partner, { siteId: SITE }, { org_id: CLIENT, permission: 'admin' })).status).toBe(403);
    expect((await call('share', 'PATCH', partner, { siteId: SITE, shareId: 'partner-share' }, { permission: 'admin' })).status).toBe(403);
    expect((await call('share', 'DELETE', partner, { siteId: SITE, shareId: 'partner-share' })).status).toBe(403);
  });

  it('rejects malformed share ids without touching the datastore', async () => {
    const token = await key(ORG, SITE);
    expect((await call('share', 'DELETE', token, { siteId: SITE, shareId: '../x' })).status).toBe(404);
  });
});

describe('organization invites through the public API', () => {
  it('mints an editor invite link for the key organization', async () => {
    vi.stubEnv('FORMS_HMAC_SECRET', 'synthetic-invite-signing-secret-32-characters');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'https://portal.test/');
    const token = await key(ORG, null);
    const res = await call('invites', 'POST', token, {}, { ttl_days: 90 });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ ttl_days: 30, role: 'editor' });
    expect(res.json.invite_url).toMatch(/^https:\/\/portal\.test\/onboarding\?invite=/);
    const { extractTokenFromInput, verifyInviteToken } = await import('../../lib/invite');
    expect(verifyInviteToken(extractTokenFromInput(res.json.invite_url))).toEqual({ orgId: ORG });
  });

  it('defaults the lifetime when no body is sent', async () => {
    vi.stubEnv('FORMS_HMAC_SECRET', 'synthetic-invite-signing-secret-32-characters');
    const token = await key(ORG, null);
    const res = await call('invites', 'POST', token, {});
    expect(res.status).toBe(201);
    expect(res.json.ttl_days).toBe(7);
  });

  it('refuses site-scoped keys and an unconfigured signing secret', async () => {
    vi.stubEnv('FORMS_HMAC_SECRET', 'synthetic-invite-signing-secret-32-characters');
    expect((await call('invites', 'POST', await key(ORG, SITE), {}, {})).status).toBe(403);
    vi.stubEnv('FORMS_HMAC_SECRET', '');
    expect((await call('invites', 'POST', await key(ORG, null), {}, {})).status).toBe(503);
  });
});
