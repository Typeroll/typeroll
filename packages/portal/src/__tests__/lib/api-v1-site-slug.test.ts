// Site slug + fallback URL derivation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(siteOver: Partial<Site> = {}): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(), ...siteOver,
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

interface CallInit { headers?: HeadersInit; body?: unknown }
async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: CallInit,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string' ? JSON.stringify(init.body) : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

describe('publicUrlsFor includes fallback URL derived from slug + SITES_BASE_DOMAIN', () => {
  const originalBase = process.env.SITES_BASE_DOMAIN;
  beforeEach(async () => { await resetDatastore(); });
  afterEach(() => {
    if (originalBase === undefined) delete process.env.SITES_BASE_DOMAIN;
    else process.env.SITES_BASE_DOMAIN = originalBase;
  });

  it('omits fallback when SITES_BASE_DOMAIN is unset', async () => {
    delete process.env.SITES_BASE_DOMAIN;
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { urls: { fallback: string | null } };
    expect(body.urls.fallback).toBeNull();
  });

  it('uses site.slug + base domain to construct fallback', async () => {
    process.env.SITES_BASE_DOMAIN = 'sites.typeroll.app';
    const { token } = await setup({ slug: 'norrflytt' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { urls: { fallback: string } };
    expect(body.urls.fallback).toBe('https://norrflytt.sites.typeroll.app');
  });

  it('falls back to site.id when slug not set', async () => {
    process.env.SITES_BASE_DOMAIN = 'sites.typeroll.app';
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { urls: { fallback: string } };
    expect(body.urls.fallback).toBe('https://mysite.sites.typeroll.app');
  });

  it('prefers hosting_config.fallback_subdomain when already provisioned', async () => {
    process.env.SITES_BASE_DOMAIN = 'sites.typeroll.app';
    const { token } = await setup({
      slug: 'norrflytt',
      hosting_config: { fallback_subdomain: 'legacy-attached-host.sites.typeroll.app' },
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { urls: { fallback: string } };
    expect(body.urls.fallback).toBe('https://legacy-attached-host.sites.typeroll.app');
  });
});

// Domain-first model: the declared domain IS the production/canonical URL
// immediately. `domain_status` (pending/verified/failed) is a DNS-health
// diagnostic — it surfaces via `pending_domain` so the UI can prompt the
// customer to point DNS, but it never hides the production URL. See
// docs/domain-lifecycle-plan.md.
describe('publicUrlsFor — production follows the declared domain (domain-first)', () => {
  beforeEach(async () => { await resetDatastore(); });

  async function urlsFor(siteOver: Partial<Site>): Promise<{
    production: string | null;
    pending_domain: string | null;
    domain_status: 'pending' | 'verified' | 'live' | 'failed' | null;
  }> {
    const { token } = await setup(siteOver);
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as {
      urls: {
        production: string | null;
        pending_domain: string | null;
        domain_status: 'pending' | 'verified' | 'live' | 'failed' | null;
      };
    };
    return body.urls;
  }

  it('returns production URL when domain_status is "live"', async () => {
    const urls = await urlsFor({ domain: 'www.example.com', domain_status: 'live' });
    expect(urls.production).toBe('https://www.example.com');
    expect(urls.pending_domain).toBeNull();
    expect(urls.domain_status).toBe('live');
  });

  it('production (the visit-this URL) stays null while DNS is "pending" — agents use the fallback', async () => {
    // The canonical is already baked to the domain in the build, but the
    // agent-facing live URL must not point at a domain that doesn't resolve
    // yet (the original autopilot.se bug). pending_domain surfaces it so the
    // UI can prompt the customer to point DNS.
    const urls = await urlsFor({ domain: 'www.example.com', domain_status: 'pending' });
    expect(urls.production).toBeNull();
    expect(urls.pending_domain).toBe('www.example.com');
    expect(urls.domain_status).toBe('pending');
  });

  it('production URL becomes the domain as soon as DNS is "verified" (no separate activation step)', async () => {
    const urls = await urlsFor({ domain: 'www.example.com', domain_status: 'verified' });
    expect(urls.production).toBe('https://www.example.com');
    expect(urls.pending_domain).toBeNull();
    expect(urls.domain_status).toBe('verified');
  });

  it('production stays null when DNS verification "failed" — agents use the fallback', async () => {
    const urls = await urlsFor({
      domain: 'www.example.com',
      domain_status: 'failed',
      domain_failure_reason: 'CNAME not pointing at the project',
    } as Partial<Site>);
    expect(urls.production).toBeNull();
    expect(urls.pending_domain).toBe('www.example.com');
    expect(urls.domain_status).toBe('failed');
  });

  it('treats legacy site (domain set, no domain_status, DNS once verified) as live', async () => {
    // Legacy compat requires PROOF of verification — domain_verified_at.
    const urls = await urlsFor({
      domain: 'www.legacy.com',
      domain_verified_at: '2026-01-01T00:00:00.000Z',
    } as Partial<Site>);
    expect(urls.production).toBe('https://www.legacy.com');
    expect(urls.pending_domain).toBeNull();
    // Resolver reports the implicit lifecycle as 'live' so clients have
    // a single non-null shape to render.
    expect(urls.domain_status).toBe('live');
  });

  it('treats a bare domain (no domain_status, never verified) as pending — never live', async () => {
    // Regression: the pre-fix site-creation form wrote `domain` raw onto
    // the site doc. The old `?? 'live'` fallback then surfaced an
    // unregistered, DNS-less domain as the production URL.
    const urls = await urlsFor({ domain: 'gruppsupporter.se' });
    expect(urls.production).toBeNull();
    expect(urls.pending_domain).toBe('gruppsupporter.se');
    expect(urls.domain_status).toBe('pending');
  });

  it('reports null for all domain fields when no domain is set', async () => {
    const urls = await urlsFor({});
    expect(urls.production).toBeNull();
    expect(urls.pending_domain).toBeNull();
    expect(urls.domain_status).toBeNull();
  });
});

describe('PATCH /v1/sites/{id}', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('updates name + slug + domain', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { name: 'Acme', slug: 'acme', domain: 'www.acme.io' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; slug: string; domain: string };
    expect(body.name).toBe('Acme');
    expect(body.slug).toBe('acme');
    expect(body.domain).toBe('www.acme.io');
  });

  it('rejects malformed slugs', async () => {
    const { token } = await setup();
    const bad = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { slug: 'NOT_KEBAB' } },
    );
    expect(bad.status).toBe(400);
    const startsWithDash = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { slug: '-leading' } },
    );
    expect(startsWithDash.status).toBe(400);
  });

  it('409 when slug clashes with another site in the org', async () => {
    const { token } = await setup({ slug: 'acme' });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(ORG, 'other'), {
      name: 'Other', slug: 'other-slug', created_at: new Date().toISOString(),
    } satisfies Partial<Site>);

    // Try to update OTHER to also claim "acme"
    const { token: otherToken } = await (async () => {
      const { createApiKey } = await import('../../lib/api-keys');
      return createApiKey({ orgId: ORG, siteId: 'other', name: 't', createdBy: 'a' });
    })();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/other`,
      { siteId: 'other' },
      { headers: bearer(otherToken), body: { slug: 'acme' } },
    );
    expect(res.status).toBe(409);
  });

  it('empty string clears slug + domain', async () => {
    const { token } = await setup({ slug: 'acme', domain: 'acme.io' } as Partial<Site>);
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { slug: '', domain: '' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { slug?: string; domain?: string };
    expect(body.slug).toBeUndefined();
    expect(body.domain).toBeUndefined();
  });
});

// slug re-points the platform fallback hostname and domain becomes every
// build's canonical URL: both need site admin, as in the portal settings.
describe('PATCH /v1/sites/{id} — slug and domain need admin', () => {
  const OWNER_ORG = 'ownerorg';
  const SHARED = 'shared-site';

  async function writeShareKey(): Promise<string> {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(OWNER_ORG, SHARED), { name: 'Shared', slug: 'shared', created_at: new Date().toISOString() });
    await getStore().setDoc(paths.version(OWNER_ORG, SHARED, MAIN_VERSION_ID), {
      name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
    } satisfies Partial<SiteVersion>);
    const { writeShare } = await import('../../lib/shares');
    await writeShare({
      id: 'share-w', site_id: SHARED, owner_org_id: OWNER_ORG, shared_with_org_id: ORG,
      permission: 'write', created_at: Date.now(), created_by: 'owner@example.com',
    });
    const { createApiKey } = await import('../../lib/api-keys');
    return (await createApiKey({ orgId: ORG, siteId: null, name: 'org', createdBy: 'a' })).token;
  }

  beforeEach(async () => { await resetDatastore(); });

  it.each([{ slug: 'victim-label' }, { domain: 'www.victim.example' }])('refuses %o from a write-level caller', async (body) => {
    const token = await writeShareKey();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SHARED}`,
      { siteId: SHARED },
      { headers: bearer(token), body },
    );
    expect(res.status).toBe(403);
    const { getStore } = await import('../../lib/datastore');
    const site = await getStore().getDoc<Site>(paths.site(OWNER_ORG, SHARED));
    expect(site?.slug).toBe('shared');
    expect(site?.domain).toBeUndefined();
  });

  it('still lets a write-level caller rename the site', async () => {
    const token = await writeShareKey();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SHARED}`,
      { siteId: SHARED },
      { headers: bearer(token), body: { name: 'Renamed' } },
    );
    expect(res.status).toBe(200);
  });
});

describe('PATCH /v1/sites/{id} — fallback hostname held by another organization', () => {
  const env = { ...process.env };
  afterEach(() => {
    for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SITES_BASE_DOMAIN'] as const) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    vi.unstubAllGlobals();
  });

  it('answers 409 and keeps the slug when the hostname is claimed by a site in another organization', async () => {
    const { token } = await setup({ slug: 'mine' });
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
    process.env.CLOUDFLARE_API_TOKEN = 'tok';
    process.env.SITES_BASE_DOMAIN = 'sites.typeroll.app';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { claimFallbackHostname } = await import('../../lib/hosting/fallback-hostnames');
    await claimFallbackHostname('victim.sites.typeroll.app', { orgId: 'victim-org', siteId: 'shop' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { slug: 'victim' } },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'slug_unavailable' });
    // Refused before any Cloudflare call: no domain attach, no DNS write.
    expect(fetchMock).not.toHaveBeenCalled();
    const { getStore } = await import('../../lib/datastore');
    expect((await getStore().getDoc<Site>(paths.site(ORG, SITE)))?.slug).toBe('mine');
  });
});

