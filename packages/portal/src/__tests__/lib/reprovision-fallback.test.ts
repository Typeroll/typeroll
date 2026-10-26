// reprovisionFallbackSubdomain — re-attaches a slugged subdomain to CF
// Pages + writes the CNAME when an agent changes Site.slug.
//
// Tests mock the Cloudflare API client so we don't hit prod. The contract
// being verified: given accountId + apiToken + SITES_BASE_DOMAIN, the
// function calls attachCustomDomain, looks up the zone, upserts the
// CNAME, and returns the fully-qualified host + CNAME target.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures } from '../helpers/tmp-fixtures';

describe('reprovisionFallbackSubdomain', () => {
  const originalEnv = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    SITES_BASE_DOMAIN: process.env.SITES_BASE_DOMAIN,
  };

  beforeEach(() => {
    vi.resetModules();
    makeTmpFixtures();
  });

  afterEach(() => {
    Object.entries(originalEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  it('returns null when Cloudflare credentials are missing', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.SITES_BASE_DOMAIN = 'sites.example.com';
    const { reprovisionFallbackSubdomain } = await import('../../lib/hosting/site-provisioning');
    const result = await reprovisionFallbackSubdomain({ orgId: 'o', siteId: 's', newSlug: 'foo' });
    expect(result).toBeNull();
  });

  it('returns null when SITES_BASE_DOMAIN is unset (self-host)', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
    process.env.CLOUDFLARE_API_TOKEN = 'tok';
    delete process.env.SITES_BASE_DOMAIN;
    const { reprovisionFallbackSubdomain } = await import('../../lib/hosting/site-provisioning');
    const result = await reprovisionFallbackSubdomain({ orgId: 'o', siteId: 's', newSlug: 'foo' });
    expect(result).toBeNull();
  });

  it('attaches the new host + writes CNAME when CF + base are configured', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
    process.env.CLOUDFLARE_API_TOKEN = 'tok';
    process.env.SITES_BASE_DOMAIN = 'sites.typeroll.com';

    const attachCalls: Array<{ project: string; domain: string }> = [];
    const dnsCalls: Array<{ name: string; content: string; type: string }> = [];
    const projectCreates: string[] = [];

    const actual = await vi.importActual<typeof import('../../lib/hosting/cloudflare-api')>('../../lib/hosting/cloudflare-api');
    vi.doMock('../../lib/hosting/cloudflare-api', () => ({
      CloudflareConflictError: actual.CloudflareConflictError,
      CloudflareApi: class {
        constructor(_cfg: unknown) {}
        async createPagesProject(name: string): Promise<{ name: string; subdomain: string }> {
          projectCreates.push(name);
          return { name, subdomain: `${name}.pages.dev` };
        }
        async attachCustomDomain(project: string, domain: string): Promise<void> {
          attachCalls.push({ project, domain });
        }
        async getZoneId(_zone: string): Promise<string> { return 'zone-id'; }
        async findDnsRecords(): Promise<Array<{ id: string; content: string }>> { return []; }
        async upsertDnsRecord(rec: { name: string; content: string; type: string }): Promise<void> {
          dnsCalls.push(rec);
        }
      },
      // Re-export the project-name helper — site-provisioning imports it
      // alongside CloudflareApi, so the mock has to provide both.
      pagesProjectNameForSite: (orgId: string, siteId: string) => `tr-${orgId}-${siteId}`,
    }));

    const { reprovisionFallbackSubdomain } = await import('../../lib/hosting/site-provisioning');
    const result = await reprovisionFallbackSubdomain({
      orgId: 'default', siteId: 'default', newSlug: 'acme',
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.fallbackSubdomain).toBe('acme.sites.typeroll.com');
    expect(result.cnameTarget).toMatch(/\.pages\.dev$/);
    // Caller persists this onto hosting_config so trigger_deploy targets
    // the project the new subdomain is attached to (not the env fallback).
    expect(result.pagesProject).toBe('tr-default-default');

    // Self-heal: project gets ensured before the domain attach. This
    // matters for sites bootstrapped outside the create flow that never
    // had a Pages project provisioned.
    expect(projectCreates).toEqual(['tr-default-default']);

    expect(attachCalls.length).toBe(1);
    expect(attachCalls[0].domain).toBe('acme.sites.typeroll.com');

    expect(dnsCalls.length).toBe(1);
    expect(dnsCalls[0].name).toBe('acme.sites.typeroll.com');
    expect(dnsCalls[0].type).toBe('CNAME');
    expect(dnsCalls[0].content).toMatch(/\.pages\.dev$/);
  });
});

// Fallback hostnames live in one shared zone written with the platform's
// Cloudflare token, but site ids and slugs are unique per organization only.
// A second organization must never re-point another site's fallback URL.
describe('fallback hostname ownership', () => {
  const originalEnv = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    SITES_BASE_DOMAIN: process.env.SITES_BASE_DOMAIN,
  };
  // Zone state shared by every fake client instance: CNAME name → target,
  // and Pages custom domain → project.
  let dns: Map<string, string>;
  let attached: Map<string, string>;
  let calls: string[];

  beforeEach(async () => {
    vi.resetModules();
    makeTmpFixtures();
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
    process.env.CLOUDFLARE_API_TOKEN = 'tok';
    process.env.SITES_BASE_DOMAIN = 'sites.typeroll.com';
    dns = new Map();
    attached = new Map();
    calls = [];
    const actual = await vi.importActual<typeof import('../../lib/hosting/cloudflare-api')>('../../lib/hosting/cloudflare-api');
    vi.doMock('../../lib/hosting/cloudflare-api', () => ({
      ...actual,
      CloudflareApi: class {
        async createPagesProject(name: string) { return { name, subdomain: `${name}.pages.dev` }; }
        async getZoneId() { return 'zone'; }
        async findDnsRecords(_zone: string, _type: string, name: string) {
          return dns.has(name) ? [{ id: name, content: dns.get(name)! }] : [];
        }
        async attachCustomDomain(project: string, domain: string) {
          calls.push(`attach ${domain} ${project}`);
          const holder = attached.get(domain);
          if (holder && holder !== project) throw new actual.CloudflareConflictError('domain_in_use', 'in use');
          attached.set(domain, project);
        }
        async upsertDnsRecord(rec: { name: string; content: string }) {
          calls.push(`dns ${rec.name} ${rec.content}`);
          const existing = dns.get(rec.name);
          if (existing && existing !== rec.content) throw new actual.CloudflareConflictError('dns_record_conflict', 'conflict');
          dns.set(rec.name, rec.content);
        }
      },
    }));
  });

  afterEach(() => {
    Object.entries(originalEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  it('refuses a slug whose hostname another organization\'s site has claimed', async () => {
    const { reprovisionFallbackSubdomain, FallbackHostnameUnavailableError } = await import('../../lib/hosting/site-provisioning');
    await reprovisionFallbackSubdomain({ orgId: 'victim', siteId: 'shop', newSlug: 'acme' });
    expect(dns.get('acme.sites.typeroll.com')).toBe('tr-victim-shop.pages.dev');
    calls = [];

    await expect(reprovisionFallbackSubdomain({ orgId: 'attacker', siteId: 'mine', newSlug: 'acme' }))
      .rejects.toBeInstanceOf(FallbackHostnameUnavailableError);
    expect(calls).toEqual([]);
    expect(dns.get('acme.sites.typeroll.com')).toBe('tr-victim-shop.pages.dev');
  });

  it('refuses an unclaimed legacy hostname whose CNAME points at another project, before attaching it', async () => {
    dns.set('legacy.sites.typeroll.com', 'tr-victim-old.pages.dev');
    const { reprovisionFallbackSubdomain, FallbackHostnameUnavailableError } = await import('../../lib/hosting/site-provisioning');
    await expect(reprovisionFallbackSubdomain({ orgId: 'attacker', siteId: 'mine', newSlug: 'legacy' }))
      .rejects.toBeInstanceOf(FallbackHostnameUnavailableError);
    expect(calls).toEqual([]);
    expect(dns.get('legacy.sites.typeroll.com')).toBe('tr-victim-old.pages.dev');

    // The failed attempt released its claim: the label is not stranded.
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc('fallback_hostnames/legacy.sites.typeroll.com')).toBeNull();
  });

  it('refuses an unclaimed hostname another Pages project holds', async () => {
    attached.set('held.sites.typeroll.com', 'tr-victim-old');
    const { reprovisionFallbackSubdomain, FallbackHostnameUnavailableError } = await import('../../lib/hosting/site-provisioning');
    await expect(reprovisionFallbackSubdomain({ orgId: 'attacker', siteId: 'mine', newSlug: 'held' }))
      .rejects.toBeInstanceOf(FallbackHostnameUnavailableError);
    expect(dns.has('held.sites.typeroll.com')).toBe(false);
  });

  it('is idempotent for the site that already holds the hostname', async () => {
    const { reprovisionFallbackSubdomain } = await import('../../lib/hosting/site-provisioning');
    await reprovisionFallbackSubdomain({ orgId: 'org', siteId: 'shop', newSlug: 'acme' });
    const again = await reprovisionFallbackSubdomain({ orgId: 'org', siteId: 'shop', newSlug: 'acme' });
    expect(again?.fallbackSubdomain).toBe('acme.sites.typeroll.com');
  });

  it('never provisions a platform fallback for a customer Git site', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site('org', 'git-site'), { name: 'Git', publishing_mode: 'customer_git' });
    const { reprovisionFallbackSubdomain, needsFallbackProvisioning } = await import('../../lib/hosting/site-provisioning');
    expect(await reprovisionFallbackSubdomain({ orgId: 'org', siteId: 'git-site', newSlug: 'acme' })).toBeNull();
    expect(needsFallbackProvisioning({ publishing_mode: 'customer_git' }, 'acme')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('gives a new site with a taken id a unique suffixed hostname instead of re-pointing the existing one', async () => {
    const { getStore } = await import('../../lib/datastore');
    for (const org of ['victim', 'attacker']) await getStore().setDoc(paths.site(org, 'acme'), { name: 'Acme' });
    const { provisionSiteHosting } = await import('../../lib/hosting/site-provisioning');
    const first = await provisionSiteHosting('victim', 'acme');
    expect(first?.fallbackSubdomain).toBe('acme.sites.typeroll.com');

    const second = await provisionSiteHosting('attacker', 'acme');
    expect(second?.fallbackSubdomain).toMatch(/^acme-[0-9a-f]{6}\.sites\.typeroll\.com$/);
    expect(dns.get('acme.sites.typeroll.com')).toBe('tr-victim-acme.pages.dev');
    expect(dns.get(second!.fallbackSubdomain!)).toBe('tr-attacker-acme.pages.dev');
  });
});

describe('needsFallbackProvisioning', () => {
  it('repairs an unchanged slug when either hosting coordinate is missing', async () => {
    const { needsFallbackProvisioning } = await import('../../lib/hosting/site-provisioning');
    expect(needsFallbackProvisioning({ slug: 'acme' }, 'acme')).toBe(true);
    expect(needsFallbackProvisioning({
      slug: 'acme',
      hosting_config: { fallback_subdomain: 'acme.sites.example.com' },
    }, 'acme')).toBe(true);
  });

  it('is a no-op only when the slug and both hosting coordinates match', async () => {
    const { needsFallbackProvisioning } = await import('../../lib/hosting/site-provisioning');
    expect(needsFallbackProvisioning({
      slug: 'acme',
      hosting_config: {
        fallback_subdomain: 'acme.sites.example.com',
        pages_project: 'tr-org-site',
      },
    }, 'acme')).toBe(false);
  });
});
