// Regression tests for the "fresh site shows ● Live — DNS verified" bug.
//
// The create-site form used to write the typed domain raw onto the Site
// doc (no domain_status, no registration); toResponse's legacy
// `?? 'live'` fallback then presented the unregistered, DNS-less domain
// as verified/live in DomainManager (observed with gruppsupporter.se).
//
// Two layers are pinned down here:
//   1. POST /api/sites/create with a domain saves it as the future website
//      host in Publishing (prepared and verified there) — never an implied
//      live domain — and drops an invalid one.
//   2. getDomainState's legacy fallback (hosted sites) only reads a missing
//      domain_status as 'live' when domain_verified_at proves DNS was
//      once confirmed.
//
// The fixtures backend handles persistence. The create route runs under
// the dev session (orgId 'default') since Firebase isn't configured in tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';

const ORG = 'default'; // dev-session org

function fakeCookies(): { get: () => undefined } {
  // No session cookie + no FIREBASE_SERVICE_ACCOUNT → getSession returns
  // the dev user (orgId 'default').
  return { get: () => undefined };
}

async function postCreate(fields: Record<string, string>): Promise<Response> {
  const { POST } = await import('../../pages/api/sites/create');
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const request = new Request('http://127.0.0.1:4321/api/sites/create', {
    method: 'POST',
    body: form,
  });
  const redirect = (path: string) =>
    new Response(null, { status: 302, headers: { Location: path } });
  return POST({ request, cookies: fakeCookies(), redirect } as unknown as Parameters<typeof POST>[0]);
}

async function readSite(siteId: string): Promise<Site | null> {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<Site>(paths.site(ORG, siteId));
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.SITES_BASE_DOMAIN;
});

afterEach(() => {
  vi.resetModules();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
});

describe('POST /api/sites/create with a domain', () => {
  it('saves the domain as the future website host of a site that publishes through its organization — never live', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-acct';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';

    const res = await postCreate({ name: 'Gruppsupporter', domain: 'gruppsupporter.se' });
    expect(res.status).toBe(302);

    const site = await readSite('gruppsupporter');
    expect(site?.publishing_mode).toBe('customer_git');
    expect(site?.domain).toBeUndefined();
    expect(site?.domain_status).toBeUndefined();

    const { getSiteDomains } = await import('../../lib/publishing/domain-config');
    const domains = await getSiteDomains(ORG, 'gruppsupporter');
    expect(domains.desired.website_host).toBe('gruppsupporter.se');
    expect(domains.state).not.toBe('live');
  });

  it('drops an invalid domain instead of persisting it or failing the new site', async () => {
    const res = await postCreate({ name: 'Typo Site', domain: 'not a domain' });
    expect(res.status).toBe(302);

    const site = await readSite('typo-site');
    expect(site?.name).toBe('Typo Site');
    expect(site?.domain).toBeUndefined();
    const { getSiteDomains } = await import('../../lib/publishing/domain-config');
    expect((await getSiteDomains(ORG, 'typo-site')).desired.website_host).toBeNull();
  });
});

describe('getDomainState legacy fallback (missing domain_status)', () => {
  it('a bare domain with no lifecycle fields reads as pending — the gruppsupporter regression', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(ORG, 'legacy-bare'), {
      name: 'Legacy Bare',
      domain: 'gruppsupporter.se',
      publishing_mode: 'hosted',
      hosting_adapter: 'cloudflare',
      created_at: new Date().toISOString(),
    } satisfies Partial<Site>);

    const { getDomainState } = await import('../../lib/site-domain');
    const state = await getDomainState(ORG, 'legacy-bare');
    expect(state?.status).toBe('pending');
    expect(state?.status).not.toBe('live');
    expect(state?.status).not.toBe('verified');
  });

  it('a bare domain WITH domain_verified_at reads as live (true pre-lifecycle site)', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(ORG, 'legacy-verified'), {
      name: 'Legacy Verified',
      domain: 'www.legacy.com',
      domain_verified_at: '2026-01-01T00:00:00.000Z',
      publishing_mode: 'hosted',
      hosting_adapter: 'cloudflare',
      created_at: '2026-01-01T00:00:00.000Z',
    } satisfies Partial<Site>);

    const { getDomainState } = await import('../../lib/site-domain');
    const state = await getDomainState(ORG, 'legacy-verified');
    expect(state?.status).toBe('live');
  });
});

describe('custom-domain verbs for a site without a publishing mode', () => {
  it('refuse it like any customer-published site and name the Publishing domains flow', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(ORG, 'older'), {
      name: 'Older', domain: 'www.older.example', hosting_adapter: 'cloudflare', hosting_config: { pages_project: 'older' },
      created_at: '2026-01-01T00:00:00.000Z',
    } satisfies Partial<Site>);

    const { getDomainState, requestDomain, removeDomain } = await import('../../lib/site-domain');
    for (const call of [() => getDomainState(ORG, 'older'), () => requestDomain(ORG, 'older', 'www.older.example'), () => removeDomain(ORG, 'older')]) {
      await expect(call()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('/publishing/domains') });
    }
  });
});
