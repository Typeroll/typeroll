// Cloudflare Pages serves a branch deployment on a shortened alias. The DNS
// target of a version's test address must be that alias, not one built from
// the full branch name (FC, job Hs6lHFG0Wr38b07DrErq, 2026-11-04).
import { describe, expect, it, vi } from 'vitest';
import { pagesBranchHost, pagesBranchLabel } from '../../lib/publishing/pages-alias';
import { preparePagesDomain } from '../../lib/publishing/domain-provider';
import { hostPointsAtProject } from '../../lib/publishing/pages-domain-status';

const project = 'typeroll-6c3bc46ea2e7a54e';
const longBranch = 'version-seo-sharing-render-refresh-2026-11-04';
const served = `version-seo-sharing-render-r.${project}.pages.dev`;

describe('Cloudflare Pages branch alias', () => {
  it('shortens long branch names the way Cloudflare does', () => {
    expect(pagesBranchLabel(longBranch)).toBe('version-seo-sharing-render-r');
    expect(pagesBranchHost(project, longBranch)).toBe(served);
    expect(pagesBranchLabel('version-qa')).toBe('version-qa');
    expect(pagesBranchLabel('version-Ab_c.d')).toBe('version-ab-c-d');
    // A cut that ends on a hyphen drops it.
    expect(pagesBranchLabel('version-abcdefghij-klmnopqr-stuv')).toBe('version-abcdefghij-klmnopqr');
    expect(pagesBranchHost(project, 'main')).toBe(`${project}.pages.dev`);
  });

  it('uses the alias Cloudflare returned for the deployment, never the immutable deployment host', () => {
    const deployment = { short_id: '583e5f93', aliases: [`https://583e5f93.${project}.pages.dev`, `https://${served}`] };
    expect(pagesBranchHost(project, longBranch, deployment)).toBe(served);
    expect(pagesBranchHost(project, longBranch, { aliases: [`https://custom-label.${project}.pages.dev`] })).toBe(`custom-label.${project}.pages.dev`);
    expect(pagesBranchHost(project, longBranch, { aliases: ['https://elsewhere.example.com'] })).toBe(served);
  });
});

describe('test address DNS', () => {
  const zone = [{ id: 'zone', name: 'sites.example.com', account: { id: 'account' }, status: 'active' }];
  const provider = (records: any[]) => vi.fn(async (route: string, _options?: { method?: string; body?: any }) => {
    if (route.startsWith('/zones?')) return zone;
    if (route.includes('/dns_records?')) return records;
    if (route.includes('/dns_records')) return {};
    return { status: 'active' };
  });
  const input = { accountId: 'account', project, branch: longBranch, hostname: 'v-1-site.sites.example.com', dnsMode: 'automatic' as const,
    deployment: { short_id: '583e5f93', aliases: [`https://${served}`] } };

  it('points a new test address at the branch alias Cloudflare serves', async () => {
    const dns = provider([]);
    const result = await preparePagesDomain(dns, input);
    expect(dns.mock.calls.some(([route, options]) => route === '/zones/zone/dns_records' && options?.method === 'POST' && options.body.content === served)).toBe(true);
    expect(result.requirements.at(-1)).toMatchObject({ content: served, status: 'configured' });
  });

  it("corrects Typeroll's own record that points at the full branch name", async () => {
    const wrong = { id: 'rec', type: 'CNAME', name: input.hostname, content: `${longBranch}.${project}.pages.dev`, proxied: true, comment: 'Typeroll static publication' };
    const dns = provider([wrong]);
    const result = await preparePagesDomain(dns, input);
    expect(dns.mock.calls.some(([route, options]) => route === '/zones/zone/dns_records/rec' && options?.method === 'PATCH' && options.body.content === served)).toBe(true);
    expect(result).toMatchObject({ action: 'verify', has_existing_traffic: false });
  });

  it('never rewrites a record Typeroll did not create, or a live website record', async () => {
    const foreign = { id: 'rec', type: 'CNAME', name: input.hostname, content: `other.${project}.pages.dev`, proxied: true, comment: 'Managed elsewhere' };
    const dns = provider([foreign]);
    await preparePagesDomain(dns, input);
    expect(dns.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
    const live = provider([{ ...foreign, comment: 'Typeroll static publication', content: `version-old.${project}.pages.dev` }]);
    await preparePagesDomain(live, { ...input, branch: 'main', hostname: 'live.sites.example.com' });
    expect(live.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  it('checks the record against the shortened alias', async () => {
    const records = (content: string) => vi.fn(async () => [{ type: 'CNAME', content }]);
    expect(await hostPointsAtProject({ host: input.hostname, project, branch: longBranch, zone: { provider: records(served), zoneId: 'zone' } })).toBe(true);
    expect(await hostPointsAtProject({ host: input.hostname, project, branch: longBranch, zone: { provider: records(`${longBranch}.${project}.pages.dev`), zoneId: 'zone' } })).toBe(false);
  });
});
