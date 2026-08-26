// Regression tests for the "fresh site shows ● Live — DNS verified" bug.
//
// The create-site form used to write the typed domain raw onto the Site
// doc (no domain_status, no CF Pages registration); toResponse's legacy
// `?? 'live'` fallback then presented the unregistered, DNS-less domain
// as verified/live in DomainManager (observed with gruppsupporter.se).
//
// Two layers are pinned down here:
//   1. POST /api/sites/create with a domain routes through the same
//      domain-first flow as DomainManager (requestDomain → CF Pages
//      registration → status 'pending'), degrading to 'failed' — never
//      an implied live — when CF is unavailable.
//   2. getDomainState's legacy fallback only reads a missing
//      domain_status as 'live' when domain_verified_at proves DNS was
//      once confirmed.
//
// CloudflareApi is mocked like in site-domain.test.ts; the fixtures
// backend handles persistence. The create route runs under the dev
// session (orgId 'default') since Firebase isn't configured in tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';

const ORG = 'default'; // dev-session org

let cfCalls: Array<{ method: string; args: unknown[] }>;

vi.mock('../../lib/hosting/cloudflare-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/hosting/cloudflare-api')>(
    '../../lib/hosting/cloudflare-api',
  );
  class FakeCloudflareApi {
    async createPagesProject(...args: unknown[]): Promise<void> {
      cfCalls.push({ method: 'createPagesProject', args });
    }
    async attachCustomDomain(...args: unknown[]): Promise<void> {
      cfCalls.push({ method: 'attachCustomDomain', args });
    }
    async removeCustomDomain(...args: unknown[]): Promise<void> {
      cfCalls.push({ method: 'removeCustomDomain', args });
    }
    async getCustomDomainStatus(...args: unknown[]): Promise<unknown> {
      cfCalls.push({ method: 'getCustomDomainStatus', args });
      return null;
    }
    async getZoneId(): Promise<string> { return 'zone-1'; }
    async upsertDnsRecord(): Promise<void> {}
  }
  return { ...actual, CloudflareApi: FakeCloudflareApi };
});

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
  cfCalls = [];
});

afterEach(() => {
  vi.resetModules();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
});

describe('POST /api/sites/create with a domain', () => {
  it('routes the domain through the domain-first flow: CF registration + status pending — never live/verified', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-acct';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';

    const res = await postCreate({ name: 'Gruppsupporter', domain: 'gruppsupporter.se' });
    expect(res.status).toBe(302);

    // The apex/www pair was registered on CF Pages, same as DomainManager.
    const attached = cfCalls
      .filter((c) => c.method === 'attachCustomDomain')
      .map((c) => c.args[1]);
    expect(attached).toContain('gruppsupporter.se');
    expect(attached).toContain('www.gruppsupporter.se');

    const site = await readSite('gruppsupporter');
    expect(site?.domain).toBe('gruppsupporter.se');
    expect(site?.domain_status).toBe('pending');
    expect(site?.domain_dns_target).toMatch(/\.pages\.dev$/);

    // The user-visible state: "point your DNS", not "Live — DNS verified".
    const { getDomainState } = await import('../../lib/site-domain');
    const state = await getDomainState(ORG, 'gruppsupporter');
    expect(state?.status).toBe('pending');
    expect(state?.status).not.toBe('live');
    expect(state?.status).not.toBe('verified');
  });

  it('records the domain as failed (with reason) when Cloudflare is not configured — site creation still succeeds', async () => {
    const res = await postCreate({ name: 'No CF Site', domain: 'nocf.example.com' });
    expect(res.status).toBe(302);

    const site = await readSite('no-cf-site');
    expect(site?.name).toBe('No CF Site');
    expect(site?.domain).toBe('nocf.example.com');
    expect(site?.domain_status).toBe('failed');
    expect(site?.domain_failure_reason).toMatch(/Cloudflare/);

    const { getDomainState } = await import('../../lib/site-domain');
    const state = await getDomainState(ORG, 'no-cf-site');
    expect(state?.status).toBe('failed');
  });

  it('drops an invalid domain instead of persisting it', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-acct';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';

    const res = await postCreate({ name: 'Typo Site', domain: 'not a domain' });
    expect(res.status).toBe(302);

    const site = await readSite('typo-site');
    expect(site?.name).toBe('Typo Site');
    expect(site?.domain).toBeUndefined();
    expect(site?.domain_status).toBeUndefined();

    const { getDomainState } = await import('../../lib/site-domain');
    expect(await getDomainState(ORG, 'typo-site')).toBeNull();
  });
});

describe('getDomainState legacy fallback (missing domain_status)', () => {
  it('a bare domain with no lifecycle fields reads as pending — the gruppsupporter regression', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(ORG, 'legacy-bare'), {
      name: 'Legacy Bare',
      domain: 'gruppsupporter.se',
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
      hosting_adapter: 'cloudflare',
      created_at: '2026-01-01T00:00:00.000Z',
    } satisfies Partial<Site>);

    const { getDomainState } = await import('../../lib/site-domain');
    const state = await getDomainState(ORG, 'legacy-verified');
    expect(state?.status).toBe('live');
  });
});
