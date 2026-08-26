// End-to-end tests for the share management API. Calls the route handlers
// directly (no HTTP cycle) and asserts both the response and the persisted
// state across the canonical record and the flat index.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Organization, Site, SiteShare } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const fakeCookies = { get: () => undefined } as any;
const OWNER = 'default'; // dev-session orgId — caller is admin of this org
const RECIPIENT = 'clientorg';
const SITE = 'customer-site';

async function setupOwnedSite(): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(OWNER, SITE), {
    name: 'Customer Site',
    hosting_adapter: 'cloudflare',
  } satisfies Partial<Site>);
  // Recipient org must exist so resolveTargetOrg() finds it.
  await getStore().setDoc(paths.org(RECIPIENT), {
    name: 'Client Org',
    slug: 'client-org',
    plan: 'free',
    created_at: new Date().toISOString(),
  } satisfies Partial<Organization>);
}

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/api/sites/${SITE}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sites/{siteId}/shares', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    await setupOwnedSite();
  });

  it('creates a share by org_id', async () => {
    const mod = await import('../../pages/api/sites/[siteId]/shares/index');
    const res = await (mod.POST as APIRoute)({
      request: makeRequest({ org_id: RECIPIENT, permission: 'write' }),
      params: { siteId: SITE },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    expect(res.status).toBe(200);
    const { share } = await res.json();
    expect(share.shared_with_org_id).toBe(RECIPIENT);
    expect(share.permission).toBe('write');

    const { getStore } = await import('../../lib/datastore');
    const canonical = await getStore().getDoc<SiteShare>(paths.share(OWNER, SITE, share.id));
    const indexed = await getStore().getDoc<SiteShare>(paths.sharesWithOrgEntry(RECIPIENT, share.id));
    expect(canonical).toBeTruthy();
    expect(indexed).toBeTruthy();
  });

  it('creates a share by org_slug', async () => {
    const mod = await import('../../pages/api/sites/[siteId]/shares/index');
    const res = await (mod.POST as APIRoute)({
      request: makeRequest({ org_slug: 'client-org', permission: 'read' }),
      params: { siteId: SITE },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    expect(res.status).toBe(200);
    const { share } = await res.json();
    expect(share.shared_with_org_id).toBe(RECIPIENT);
    expect(share.permission).toBe('read');
  });

  it('rejects self-share', async () => {
    const mod = await import('../../pages/api/sites/[siteId]/shares/index');
    const res = await (mod.POST as APIRoute)({
      request: makeRequest({ org_id: OWNER, permission: 'write' }),
      params: { siteId: SITE },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    expect(res.status).toBe(400);
  });

  it('rejects duplicate active share to same recipient', async () => {
    const mod = await import('../../pages/api/sites/[siteId]/shares/index');
    const first = await (mod.POST as APIRoute)({
      request: makeRequest({ org_id: RECIPIENT, permission: 'write' }),
      params: { siteId: SITE },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    expect(first.status).toBe(200);
    const dup = await (mod.POST as APIRoute)({
      request: makeRequest({ org_id: RECIPIENT, permission: 'read' }),
      params: { siteId: SITE },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    expect(dup.status).toBe(409);
  });

  it('rejects unknown permission value', async () => {
    const mod = await import('../../pages/api/sites/[siteId]/shares/index');
    const res = await (mod.POST as APIRoute)({
      request: makeRequest({ org_id: RECIPIENT, permission: 'super' }),
      params: { siteId: SITE },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/sites/{siteId}/shares/{shareId}', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    await setupOwnedSite();
  });

  it('soft-deletes canonical and hard-deletes index', async () => {
    const create = await import('../../pages/api/sites/[siteId]/shares/index');
    const createRes = await (create.POST as APIRoute)({
      request: makeRequest({ org_id: RECIPIENT, permission: 'write' }),
      params: { siteId: SITE },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    const { share } = await createRes.json();

    const mod = await import('../../pages/api/sites/[siteId]/shares/[shareId]');
    const res = await (mod.DELETE as APIRoute)({
      request: new Request('http://localhost', { method: 'DELETE' }),
      params: { siteId: SITE, shareId: share.id },
      cookies: fakeCookies,
      locals: {},
    } as any) as Response;
    expect(res.status).toBe(200);

    const { getStore } = await import('../../lib/datastore');
    const canonical = await getStore().getDoc<SiteShare>(paths.share(OWNER, SITE, share.id));
    expect(canonical?.revoked_at).toBeTruthy();
    const indexed = await getStore().getDoc(paths.sharesWithOrgEntry(RECIPIENT, share.id));
    expect(indexed).toBeNull();
  });
});
