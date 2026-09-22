// Regression tests for GET /api/v1/sites with both key classes.
//
// The bug: org-scoped keys (site_id: null) got back the placeholder site
// requireAnyApiKey builds for them — a single entry with empty id/name —
// instead of the sites the key actually reaches. The route now resolves
// reach via listAllowedSites: owned sites + shared-in sites for org keys,
// the single bound site for site-scoped keys.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteShare } from '@typeroll/shared';

const ORG = 'agencyorg';
const OTHER_ORG = 'customerorg';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const SHARED_SITE = 'shared-site';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE_A), {
    name: 'Site A', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.site(ORG, SITE_B), {
    name: 'Site B', domain: 'site-b.example', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  // A site owned by another org, shared into ORG.
  await getStore().setDoc(paths.site(OTHER_ORG, SHARED_SITE), {
    name: 'Shared Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  const { writeShare } = await import('../../lib/shares');
  await writeShare({
    id: 'share-1',
    site_id: SHARED_SITE,
    owner_org_id: OTHER_ORG,
    shared_with_org_id: ORG,
    permission: 'write',
    created_at: Date.now(),
    created_by: 'owner@customer.example',
  } satisfies SiteShare);
}

async function makeKey(siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({
    orgId: ORG, siteId, name: 'test', createdBy: 'admin@example.com',
  });
  return token;
}

async function listSites(token: string, declaredOrg?: string): Promise<{
  status: number;
  sites: Array<{ id: string; organization_id: string; name: string; domain?: string; urls: Record<string, unknown> }>;
}> {
  const mod = await import('../../pages/api/v1/sites/index') as { GET: APIRoute };
  const req = new Request('https://api.example/api/v1/sites', {
    headers: {
      authorization: `Bearer ${token}`,
      ...(declaredOrg ? { 'Typeroll-Organization': declaredOrg } : {}),
    },
  });
  const res = await mod.GET({
    request: req, params: {}, cookies: { get: () => undefined } as any, locals: {} as any,
  } as any) as Response;
  const body = res.status === 200 ? await res.json() : { sites: [] };
  return { status: res.status, sites: body.sites };
}

describe('GET /api/v1/sites', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('refuses a request that declares an organization the key is not on', async () => {
    // The damage case at Moveria: a caller meant one organization, the key was
    // on another holding a site with the same id, and the request succeeded
    // against the wrong site without anything saying so. Declaring the
    // intended organization turns that into a refusal.
    await setup();
    const token = await makeKey(null);
    const { status } = await listSites(token, OTHER_ORG);
    expect(status).toBe(409);
  });

  it('is unchanged when no organization is declared, and passes when it matches', async () => {
    // Optional forever: an existing caller that sends nothing behaves exactly
    // as before, so adopting this breaks no one.
    await setup();
    const token = await makeKey(null);
    expect((await listSites(token)).status).toBe(200);
    expect((await listSites(token, ORG)).status).toBe(200);
  });

  it('names the owning organization per site, including a shared-in one', async () => {
    // A site id is unique within an organization and not across them. Without
    // this field a caller cannot tell which organization it is pointed at
    // without one request per site, and the shared-in case is where the
    // token's organization and the owner differ — exactly when guessing from
    // the id is wrong.
    await setup();
    const token = await makeKey(null);
    const { sites } = await listSites(token);
    const byId = Object.fromEntries(sites.map((site) => [site.id, site.organization_id]));
    expect(byId[SITE_A]).toBe(ORG);
    expect(byId[SITE_B]).toBe(ORG);
    expect(byId[SHARED_SITE]).toBe(OTHER_ORG);
    for (const site of sites) expect(site.organization_id).toBeTruthy();
  });

  it('org-scoped key lists all owned sites plus shared-in sites', async () => {
    await setup();
    const token = await makeKey(null);
    const { status, sites } = await listSites(token);
    expect(status).toBe(200);
    expect(sites.map((s) => s.id).sort()).toEqual([SHARED_SITE, SITE_A, SITE_B].sort());
    // No placeholder entries — every site carries real fields.
    for (const s of sites) {
      expect(s.id).not.toBe('');
      expect(s.name).not.toBe('');
      expect(s.urls).toBeDefined();
    }
    const siteB = sites.find((s) => s.id === SITE_B)!;
    expect(siteB.name).toBe('Site B');
    expect(siteB.domain).toBe('site-b.example');
    const shared = sites.find((s) => s.id === SHARED_SITE)!;
    expect(shared.name).toBe('Shared Site');
  });

  it('site-scoped key still lists exactly its one bound site', async () => {
    await setup();
    const token = await makeKey(SITE_A);
    const { status, sites } = await listSites(token);
    expect(status).toBe(200);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.id).toBe(SITE_A);
    expect(sites[0]!.name).toBe('Site A');
    expect(sites[0]!.urls).toBeDefined();
  });

  it('401 without a bearer token', async () => {
    await setup();
    const mod = await import('../../pages/api/v1/sites/index') as { GET: APIRoute };
    const res = await mod.GET({
      request: new Request('https://api.example/api/v1/sites'),
      params: {}, cookies: { get: () => undefined } as any, locals: {} as any,
    } as any) as Response;
    expect(res.status).toBe(401);
  });
});
