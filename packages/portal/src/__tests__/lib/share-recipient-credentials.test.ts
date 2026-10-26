// A cross-org share, however privileged, must not let its recipient mint
// credentials stored under the owner, share the site further, or keep access
// after the share ends. The dev session (org `default`) is the recipient here.

import { beforeEach, describe, expect, it } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Member, Organization, SharePermission, Site, SiteApiKey } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const OWNER = 'owner-org';
const RECIPIENT = 'default'; // dev session organization
const THIRD = 'third-org';
const SITE = 'shared-site';
const cookies = { get: () => undefined } as never;

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

async function seed(permission: SharePermission = 'admin') {
  const s = await store();
  await s.setDoc(paths.site(OWNER, SITE), { name: 'Shared', hosting_adapter: 'cloudflare', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await s.setDoc(paths.version(OWNER, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
  for (const org of [OWNER, RECIPIENT, THIRD]) {
    await s.setDoc(paths.org(org), { name: org, slug: org, plan: 'free', created_at: new Date().toISOString() } satisfies Partial<Organization>);
  }
  await s.setDoc(`${paths.members(OWNER)}/owner-user`, { email: 'owner@owner.example', role: 'owner' } satisfies Partial<Member>);
  await s.setDoc(`${paths.members(RECIPIENT)}/dev-user`, { email: 'dev@typeroll.local', role: 'owner' } satisfies Partial<Member>);
  const { writeShare } = await import('../../lib/shares');
  await writeShare({ id: 'share-1', site_id: SITE, owner_org_id: OWNER, shared_with_org_id: RECIPIENT, permission, created_at: Date.now(), created_by: 'owner-user' });
}

async function call(mod: Promise<Record<string, unknown>>, method: string, params: Record<string, string>, body?: unknown, url = 'http://localhost/api'): Promise<Response> {
  const handler = (await mod)[method] as APIRoute;
  return handler({
    request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    params, cookies, locals: {},
  } as never) as Promise<Response>;
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
});

describe('share recipients (session)', () => {
  it('cannot mint a site API key on the shared site', async () => {
    await seed('admin');
    const res = await call(import('../../pages/api/sites/[siteId]/api-keys/index'), 'POST', { siteId: SITE }, { name: 'mine' });
    expect(res.status).toBe(403);
    expect(await (await store()).listDocs(paths.apiKeys(OWNER, SITE))).toHaveLength(0);
  });

  it('cannot share the site further or change its shares', async () => {
    await seed('admin');
    const created = await call(import('../../pages/api/sites/[siteId]/shares/index'), 'POST', { siteId: SITE }, { org_id: THIRD, permission: 'admin' });
    expect(created.status).toBe(403);
    const patched = await call(import('../../pages/api/sites/[siteId]/shares/[shareId]'), 'PATCH', { siteId: SITE, shareId: 'share-1' }, { permission: 'read' });
    expect(patched.status).toBe(403);
    const revoked = await call(import('../../pages/api/sites/[siteId]/shares/[shareId]'), 'DELETE', { siteId: SITE, shareId: 'share-1' });
    expect(revoked.status).toBe(403);
    expect((await (await store()).listDocs(paths.shares(OWNER, SITE))).map((share) => share.id)).toEqual(['share-1']);
  });

  it('cannot issue an Extension installation credential', async () => {
    await seed('admin');
    const res = await call(import('../../pages/api/sites/[siteId]/extensions/[installationId]/rotate-credential'), 'POST', { siteId: SITE, installationId: 'inst_any' }, {});
    expect(res.status).toBe(403);
  });

  it('lists key metadata only with admin permission', async () => {
    await seed('write');
    const res = await call(import('../../pages/api/sites/[siteId]/api-keys/index'), 'GET', { siteId: SITE });
    expect(res.status).toBe(403);
  });
});

describe('share recipients (API)', () => {
  async function orgKey(org: string) {
    const { createApiKey } = await import('../../lib/api-keys');
    return (await createApiKey({ orgId: org, siteId: null, name: org, createdBy: `admin@${org}.example` })).token;
  }

  it('cannot share the site further with an organization key', async () => {
    await seed('admin');
    const token = await orgKey(RECIPIENT);
    const handler = (await import('../../pages/api/v1/sites/[siteId]/shares/index')).POST as APIRoute;
    const res = await handler({
      request: new Request(`http://localhost/api/v1/sites/${SITE}/shares`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ org_id: THIRD, permission: 'admin' }),
      }),
      params: { siteId: SITE },
    } as never) as Response;
    expect(res.status).toBe(403);
  });

  it('does not reach the site through a stale share index entry', async () => {
    await seed('admin');
    const s = await store();
    // A half-written revoke: the canonical record says revoked, the index
    // entry was never removed.
    await s.updateDoc(paths.share(OWNER, SITE, 'share-1'), { revoked_at: Date.now() });
    const token = await orgKey(RECIPIENT);
    const { requireApiKey, listAllowedSites } = await import('../../lib/api-auth');
    const res = await requireApiKey(new Request(`http://localhost/api/v1/sites/${SITE}/pages`, { headers: { authorization: `Bearer ${token}` } }), SITE);
    expect(res.ok).toBe(false);
    expect(await listAllowedSites(RECIPIENT, null)).toEqual([]);
  });

  it('uses the canonical share permission, not the index copy', async () => {
    await seed('read');
    const s = await store();
    await s.updateDoc(paths.sharesWithOrgEntry(RECIPIENT, 'share-1'), { permission: 'admin' });
    const token = await orgKey(RECIPIENT);
    const { requireApiKey } = await import('../../lib/api-auth');
    const res = await requireApiKey(new Request(`http://localhost/api/v1/sites/${SITE}/pages`, { headers: { authorization: `Bearer ${token}` } }), SITE);
    expect(res.ok && res.value.permission).toBe('read');
  });
});

describe('site keys minted through a share before minting was owner-only', () => {
  // Such a key carries no minting organization; only its creator's email.
  async function legacyKey(createdBy: string) {
    const { createApiKey } = await import('../../lib/api-keys');
    const { token, key } = await createApiKey({ orgId: OWNER, siteId: SITE, name: 'legacy', createdBy });
    const s = await store();
    const doc = await s.getDoc<SiteApiKey & { created_by_org_id?: string }>(paths.apiKey(OWNER, SITE, key.id));
    const { created_by_org_id: _drop, id: _id, ...rest } = doc!;
    await s.setDoc(paths.apiKey(OWNER, SITE, key.id), rest);
    return { token, prefix: key.id };
  }

  async function archive(token: string): Promise<Response> {
    const handler = (await import('../../pages/api/v1/sites/[siteId]/lifecycle')).POST as APIRoute;
    return handler({
      request: new Request(`http://localhost/api/v1/sites/${SITE}/lifecycle`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      }),
      params: { siteId: SITE },
    } as never) as Response;
  }

  it('cannot change the site lifecycle; an owner member\'s legacy key still can', async () => {
    await seed('admin');
    const recipientKey = await legacyKey('dev@typeroll.local');
    expect((await archive(recipientKey.token)).status).toBe(403);
    const ownerKey = await legacyKey('Owner@Owner.example');
    expect((await archive(ownerKey.token)).status).toBe(200);
  });

  it('is revoked when the share is revoked or lowered below admin', async () => {
    await seed('admin');
    const recipientKey = await legacyKey('dev@typeroll.local');
    const ownerKey = await legacyKey('owner@owner.example');
    const { updateShare, revokeShare } = await import('../../lib/shares');
    const { verifyApiToken } = await import('../../lib/api-keys');
    await updateShare(OWNER, SITE, 'share-1', { label: 'renamed' });
    expect(await verifyApiToken(recipientKey.token)).not.toBeNull();
    await updateShare(OWNER, SITE, 'share-1', { permission: 'write' });
    expect(await verifyApiToken(recipientKey.token)).toBeNull();
    expect(await verifyApiToken(ownerKey.token)).not.toBeNull();

    const another = await legacyKey('dev@typeroll.local');
    await updateShare(OWNER, SITE, 'share-1', { permission: 'admin' });
    await revokeShare(OWNER, SITE, 'share-1');
    expect(await verifyApiToken(another.token)).toBeNull();
    expect(await verifyApiToken(ownerKey.token)).not.toBeNull();
  });
});
