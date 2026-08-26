// reprovisionFallbackSubdomain — re-attaches a slugged subdomain to CF
// Pages + writes the CNAME when an agent changes Site.slug.
//
// Tests mock the Cloudflare API client so we don't hit prod. The contract
// being verified: given accountId + apiToken + SITES_BASE_DOMAIN, the
// function calls attachCustomDomain, looks up the zone, upserts the
// CNAME, and returns the fully-qualified host + CNAME target.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('reprovisionFallbackSubdomain', () => {
  const originalEnv = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    SITES_BASE_DOMAIN: process.env.SITES_BASE_DOMAIN,
  };

  beforeEach(() => {
    vi.resetModules();
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

    vi.doMock('../../lib/hosting/cloudflare-api', () => ({
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
