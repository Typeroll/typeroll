// Service-level tests for the custom-domain lifecycle.
//
// CloudflareApi is mocked end-to-end so the tests exercise the state
// transitions in lib/site-domain.ts and the writes to the Site doc
// without hitting Cloudflare's API or needing an env-var setup. The
// fixtures backend handles persistence.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

// Per-test capture of the calls made through the mocked CloudflareApi
// instance so we can assert against them.
let cfCalls: Array<{ method: string; args: unknown[] }>;
let cfDomainStatus: string;       // CF's reported `status` value
let cfDomainAttached: boolean;
// Optional hook — when set, attachCustomDomain throws for that hostname.
// Used by the "rollback on alias failure" pair test to simulate a CF
// error mid-pair without needing a separate vi.mock.
let cfAttachFailsForHost: string | null;

vi.mock('../../lib/hosting/cloudflare-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/hosting/cloudflare-api')>(
    '../../lib/hosting/cloudflare-api',
  );
  class FakeCloudflareApi {
    constructor() {}
    async attachCustomDomain(...args: unknown[]): Promise<void> {
      cfCalls.push({ method: 'attachCustomDomain', args });
      const host = args[1] as string;
      if (cfAttachFailsForHost && host === cfAttachFailsForHost) {
        throw new Error(`fake CF error: ${host} already in use`);
      }
      cfDomainAttached = true;
    }
    async removeCustomDomain(...args: unknown[]): Promise<void> {
      cfCalls.push({ method: 'removeCustomDomain', args });
      cfDomainAttached = false;
    }
    async getCustomDomainStatus(...args: unknown[]): Promise<unknown> {
      cfCalls.push({ method: 'getCustomDomainStatus', args });
      if (!cfDomainAttached) return null;
      return {
        name: args[1],
        status: cfDomainStatus,
        verification_status: null,
        validation_status: null,
        certificate_authority: 'lets_encrypt',
      };
    }
  }
  return { ...actual, CloudflareApi: FakeCloudflareApi };
});

async function setup(siteOver: Partial<Site> = {}): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-acct';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  cfCalls = [];
  cfDomainStatus = 'pending';
  cfDomainAttached = false;
  cfAttachFailsForHost = null;
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site',
    hosting_adapter: 'cloudflare',
    created_at: new Date().toISOString(),
    ...siteOver,
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main',
    kind: 'main',
    created_at: new Date().toISOString(),
    robots_blocked: false,
  } satisfies Partial<SiteVersion>);
}

async function readSite(): Promise<Site> {
  const { getStore } = await import('../../lib/datastore');
  return (await getStore().getDoc<Site>(paths.site(ORG, SITE)))!;
}

describe('requestDomain', () => {
  beforeEach(async () => { await setup(); });
  afterEach(() => { vi.resetModules(); });

  it('calls Cloudflare.attachCustomDomain and writes the site doc', async () => {
    const { requestDomain } = await import('../../lib/site-domain');
    const result = await requestDomain(ORG, SITE, 'shop.example.com');
    expect(result.hostname).toBe('shop.example.com');
    expect(result.status).toBe('pending');
    expect(result.dns_target).toMatch(/\.pages\.dev$/);
    expect(cfCalls.some((c) => c.method === 'attachCustomDomain')).toBe(true);

    const site = await readSite();
    expect(site.domain).toBe('shop.example.com');
    expect(site.domain_status).toBe('pending');
    expect(site.domain_added_at).toBeTruthy();
    expect(site.domain_dns_target).toMatch(/\.pages\.dev$/);
  });

  it('normalises hostname (strips protocol, lowercases, trims)', async () => {
    const { requestDomain } = await import('../../lib/site-domain');
    const result = await requestDomain(ORG, SITE, '  HTTPS://Shop.Example.COM/  ');
    expect(result.hostname).toBe('shop.example.com');
  });

  it('rejects an obviously invalid hostname', async () => {
    const { requestDomain, DomainServiceError } = await import('../../lib/site-domain');
    await expect(requestDomain(ORG, SITE, 'not a domain')).rejects.toBeInstanceOf(DomainServiceError);
    await expect(requestDomain(ORG, SITE, 'localhost')).rejects.toBeInstanceOf(DomainServiceError);
    await expect(requestDomain(ORG, SITE, '..')).rejects.toBeInstanceOf(DomainServiceError);
  });

  it('rejects adding a different domain when one is already set', async () => {
    const { requestDomain, DomainServiceError } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    await expect(requestDomain(ORG, SITE, 'www.other.com')).rejects.toMatchObject({
      status: 409,
    });
    // CF should NOT have been called a second time
    const attachCount = cfCalls.filter((c) => c.method === 'attachCustomDomain').length;
    expect(attachCount).toBe(1);
  });

  it('is idempotent when called with the same hostname already attached', async () => {
    const { requestDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    const second = await requestDomain(ORG, SITE, 'shop.example.com');
    expect(second.status).toBe('pending');
    // First call attached once. Second call short-circuited — total = 1.
    expect(cfCalls.filter((c) => c.method === 'attachCustomDomain').length).toBe(1);
  });

  it('returns 503 when Cloudflare is not configured', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const { requestDomain, DomainServiceError } = await import('../../lib/site-domain');
    await expect(requestDomain(ORG, SITE, 'shop.example.com')).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('pollDomainStatus', () => {
  beforeEach(async () => { await setup(); });

  it('flips pending → verified when Cloudflare reports active', async () => {
    const { requestDomain, pollDomainStatus } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainStatus = 'active';

    const result = await pollDomainStatus(ORG, SITE);
    expect(result.status).toBe('verified');
    expect(result.verified_at).toBeTruthy();

    const site = await readSite();
    expect(site.domain_status).toBe('verified');
    expect(site.domain_verified_at).toBeTruthy();
  });

  it('stays pending when CF still reports pending', async () => {
    const { requestDomain, pollDomainStatus } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainStatus = 'pending';

    const result = await pollDomainStatus(ORG, SITE);
    expect(result.status).toBe('pending');
    const site = await readSite();
    expect(site.domain_verified_at).toBeFalsy();
  });

  it('flips to failed when CF reports error, with reason', async () => {
    const { requestDomain, pollDomainStatus } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainStatus = 'error';

    const result = await pollDomainStatus(ORG, SITE);
    expect(result.status).toBe('failed');
    expect(result.failure_reason).toBeTruthy();
  });

  it('preserves live state when CF still reports active', async () => {
    const { requestDomain, pollDomainStatus, activateDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainStatus = 'active';
    await pollDomainStatus(ORG, SITE);     // pending → verified
    await activateDomain(ORG, SITE);       // verified → live

    const polled = await pollDomainStatus(ORG, SITE);
    expect(polled.status).toBe('live');     // stays live
  });

  it('throws 410 + clears site doc when CF no longer knows about the domain', async () => {
    const { requestDomain, pollDomainStatus, DomainServiceError } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainAttached = false;              // simulate out-of-band removal

    await expect(pollDomainStatus(ORG, SITE)).rejects.toMatchObject({ status: 410 });
    const site = await readSite();
    expect(site.domain).toBeUndefined();
    expect(site.domain_status).toBeUndefined();
  });
});

describe('activateDomain', () => {
  beforeEach(async () => { await setup(); });

  it('flips verified → live', async () => {
    const { requestDomain, pollDomainStatus, activateDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainStatus = 'active';
    await pollDomainStatus(ORG, SITE);

    const result = await activateDomain(ORG, SITE);
    expect(result.status).toBe('live');
    const site = await readSite();
    expect(site.domain_status).toBe('live');
  });

  it('refuses to activate a pending domain (412)', async () => {
    const { requestDomain, activateDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    await expect(activateDomain(ORG, SITE)).rejects.toMatchObject({ status: 412 });
  });

  it('refuses to activate a failed domain (412)', async () => {
    const { requestDomain, pollDomainStatus, activateDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainStatus = 'error';
    await pollDomainStatus(ORG, SITE);
    await expect(activateDomain(ORG, SITE)).rejects.toMatchObject({ status: 412 });
  });

  it('is idempotent on already-live domains', async () => {
    const { requestDomain, pollDomainStatus, activateDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    cfDomainStatus = 'active';
    await pollDomainStatus(ORG, SITE);
    await activateDomain(ORG, SITE);
    const second = await activateDomain(ORG, SITE);
    expect(second.status).toBe('live');
  });
});

describe('removeDomain', () => {
  beforeEach(async () => { await setup(); });

  it('calls Cloudflare.removeCustomDomain and clears the site doc', async () => {
    const { requestDomain, removeDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'shop.example.com');
    expect((await readSite()).domain).toBe('shop.example.com');

    await removeDomain(ORG, SITE);
    expect(cfCalls.some((c) => c.method === 'removeCustomDomain')).toBe(true);
    const site = await readSite();
    expect(site.domain).toBeUndefined();
    expect(site.domain_status).toBeUndefined();
    expect(site.domain_added_at).toBeUndefined();
    expect(site.domain_dns_target).toBeUndefined();
  });

  it('is a no-op when no domain is attached', async () => {
    const { removeDomain } = await import('../../lib/site-domain');
    const result = await removeDomain(ORG, SITE);
    expect(result.ok).toBe(true);
    expect(cfCalls.filter((c) => c.method === 'removeCustomDomain').length).toBe(0);
  });
});

// ─── Apex/www pair invariants ─────────────────────────────────────────
//
// The autopilot.se "522 on apex" rewrite. These tests exercise:
//   • dual registration (both attachCustomDomain calls fire)
//   • canonical selection (default 'apex')
//   • rollback when alias registration fails
//   • poll examines both variants and surfaces worst-of-two
//   • activate refuses while alias is unverified
//   • remove tears down both
describe('apex/www pair', () => {
  beforeEach(async () => { await setup(); });
  afterEach(() => { vi.resetModules(); });

  it('apex input registers BOTH apex + www and stores the pair', async () => {
    const { requestDomain } = await import('../../lib/site-domain');
    const result = await requestDomain(ORG, SITE, 'autopilot.se');

    expect(result.hostname).toBe('autopilot.se');
    expect(result.alias?.hostname).toBe('www.autopilot.se');
    expect(result.canonical_kind).toBe('apex');

    const attached = cfCalls
      .filter((c) => c.method === 'attachCustomDomain')
      .map((c) => c.args[1]);
    expect(attached).toEqual(['autopilot.se', 'www.autopilot.se']);

    const site = await readSite();
    expect(site.domain).toBe('autopilot.se');
    expect(site.domain_alias).toBe('www.autopilot.se');
    expect(site.domain_canonical).toBe('apex');
    expect(site.domain_alias_status).toBe('pending');
  });

  it('www input still picks apex as canonical by default', async () => {
    const { requestDomain } = await import('../../lib/site-domain');
    const result = await requestDomain(ORG, SITE, 'www.autopilot.se');
    expect(result.hostname).toBe('autopilot.se');
    expect(result.alias?.hostname).toBe('www.autopilot.se');
    const site = await readSite();
    expect(site.domain).toBe('autopilot.se');
    expect(site.domain_alias).toBe('www.autopilot.se');
  });

  it("respects prefer: 'www' override", async () => {
    const { requestDomain } = await import('../../lib/site-domain');
    const result = await requestDomain(ORG, SITE, 'autopilot.se', { prefer: 'www' });
    expect(result.hostname).toBe('www.autopilot.se');
    expect(result.alias?.hostname).toBe('autopilot.se');
    expect(result.canonical_kind).toBe('www');
    const site = await readSite();
    expect(site.domain).toBe('www.autopilot.se');
    expect(site.domain_alias).toBe('autopilot.se');
    expect(site.domain_canonical).toBe('www');
  });

  it('subdomain input does NOT derive a sibling (single-domain flow)', async () => {
    const { requestDomain } = await import('../../lib/site-domain');
    const result = await requestDomain(ORG, SITE, 'app.example.com');
    expect(result.alias).toBeNull();
    const site = await readSite();
    expect(site.domain).toBe('app.example.com');
    expect(site.domain_alias).toBeUndefined();
    expect(site.domain_canonical).toBeUndefined();
    const attached = cfCalls.filter((c) => c.method === 'attachCustomDomain');
    expect(attached.length).toBe(1);
  });

  it('rolls back canonical when alias registration fails (no half-state)', async () => {
    cfAttachFailsForHost = 'www.autopilot.se';
    const { requestDomain, DomainServiceError } = await import('../../lib/site-domain');
    await expect(requestDomain(ORG, SITE, 'autopilot.se')).rejects.toBeInstanceOf(DomainServiceError);

    // Canonical was rolled back via removeCustomDomain.
    const removed = cfCalls
      .filter((c) => c.method === 'removeCustomDomain')
      .map((c) => c.args[1]);
    expect(removed).toContain('autopilot.se');

    // No partial state landed on the Site doc.
    const site = await readSite();
    expect(site.domain).toBeUndefined();
    expect(site.domain_alias).toBeUndefined();
  });

  it('pollDomainStatus polls both variants and surfaces alias status independently', async () => {
    const { requestDomain, pollDomainStatus } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'autopilot.se');
    cfDomainStatus = 'active'; // applies to both via the mock

    const result = await pollDomainStatus(ORG, SITE);
    expect(result.status).toBe('verified');
    expect(result.alias?.status).toBe('verified');

    const polled = cfCalls
      .filter((c) => c.method === 'getCustomDomainStatus')
      .map((c) => c.args[1]);
    expect(polled).toContain('autopilot.se');
    expect(polled).toContain('www.autopilot.se');
  });

  it('activateDomain refuses while alias is still pending (the 522 trap)', async () => {
    const { requestDomain, activateDomain, DomainServiceError } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'autopilot.se');
    // Manually flip only the canonical to verified to simulate "user
    // pointed apex DNS but forgot www DNS" — exact autopilot.se trap.
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.site(ORG, SITE), {
      domain_status: 'verified',
      domain_alias_status: 'pending',
    });
    await expect(activateDomain(ORG, SITE)).rejects.toMatchObject({ status: 412 });
  });

  it('activateDomain succeeds when both variants are verified, flips both to live', async () => {
    const { requestDomain, activateDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'autopilot.se');
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.site(ORG, SITE), {
      domain_status: 'verified',
      domain_alias_status: 'verified',
    });
    const result = await activateDomain(ORG, SITE);
    expect(result.status).toBe('live');
    expect(result.alias?.status).toBe('live');
    const site = await readSite();
    expect(site.domain_status).toBe('live');
    expect(site.domain_alias_status).toBe('live');
  });

  it('removeDomain tears down BOTH variants on Cloudflare', async () => {
    const { requestDomain, removeDomain } = await import('../../lib/site-domain');
    await requestDomain(ORG, SITE, 'autopilot.se');
    cfCalls.length = 0;
    await removeDomain(ORG, SITE);
    const removed = cfCalls
      .filter((c) => c.method === 'removeCustomDomain')
      .map((c) => c.args[1]);
    expect(removed).toContain('autopilot.se');
    expect(removed).toContain('www.autopilot.se');

    const site = await readSite();
    expect(site.domain).toBeUndefined();
    expect(site.domain_alias).toBeUndefined();
    expect(site.domain_canonical).toBeUndefined();
  });
});
