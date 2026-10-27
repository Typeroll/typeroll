import { beforeEach, expect, it, vi } from 'vitest';
import { previousWebsiteHosts, previousHostSummary, preparePreviousHosts, checkPreviousHost, retirePreviousHosts } from '../../lib/publishing/previous-hosts';
import { ProviderError } from '../../lib/publishing/providers.mjs';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
const mocks = vi.hoisted(() => ({ provider: vi.fn(), ownership: vi.fn() }));
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: async () => ({ provider: mocks.provider, accountId: 'account', groupId: 'default' }) }));
vi.mock('../../lib/publishing/cloudflare-account-claims', () => ({ assertTrafficNotOwnedByOtherOrganization: mocks.ownership }));
vi.mock('../../lib/publishing/domain-cutover-journal', () => ({ journaledDomainProvider: (provider: any) => provider, recordDomainCutover: async () => {} }));
const old = 'site-123.sites.example.com';
const target = 'www.example.com';
const config: any = { active: { website_host: old }, media_aliases: [{ website_host: old, media_host: 'media.example.com' }, { website_host: 'deployment.project.pages.dev' }], previous_hosts: [] };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  mocks.provider.mockReset(); mocks.ownership.mockReset();
  mocks.provider.mockImplementation(async route => {
    if (route.startsWith('/zones?')) return [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' } }];
    if (route.includes('/dns_records')) return [{ id: 'dns', name: old, type: 'CNAME', content: 'project.pages.dev', proxied: true }];
    if (route.includes('/rulesets')) return null;
    throw Error(`Unexpected provider call ${route}`);
  });
});

it('finishes legacy retirement during normal publication without touching DNS or existing rules', async () => {
  const [prepared] = await preparePreviousHosts('org', 'default', [old], target, vi.fn().mockResolvedValue({ status: 'active' }), 'account', 'project');
  const original = mocks.provider.getMockImplementation()!;
  const jobPath = 'organizations/org/sites/site/deploys/job';
  let ruleset: any = { id: 'ruleset', rules: [{ ref: 'customer-rule', enabled: true }] };
  mocks.provider.mockImplementation(async (route, options) => {
    if (!route.includes('/rulesets')) return original(route, options);
    if (!options?.method) return structuredClone(ruleset);
    expect(await getStore().getDoc(`${jobPath}/previous_host_writes/${prepared.redirect!.rule.ref}`)).toMatchObject({ state: 'prepared', publication_id: 'publication' });
    expect(route).toBe('/zones/zone/rulesets/ruleset/rules');
    expect(options.method).toBe('POST');
    ruleset.rules.push(options.body);
    return { id: 'created' };
  });
  const fetcher = vi.fn(async (input: any) => new Response(null, { status: 301, headers: { location: String(input).replace(old, target) } }));
  for (let i = 0; i < 2; i++) expect(await retirePreviousHosts('org', 'site', 'default', 'publication', [old], target, [prepared], true, fetcher, jobPath)).toMatchObject([{ mode: 'redirect', status: 'verified' }]);
  expect(mocks.provider.mock.calls.filter(([, options]) => options?.method)).toHaveLength(1);
  expect(ruleset.rules[0]).toEqual({ ref: 'customer-rule', enabled: true });
  expect(await getStore().getDoc(`${jobPath}/previous_host_writes/${prepared.redirect!.rule.ref}`)).toMatchObject({ state: 'submitted', target_host: target });
});
it('keeps previous website hosts distinct from media aliases, current host and Pages addresses', () => {
  expect(previousWebsiteHosts(config, target, old)).toEqual([old]);
  expect(previousWebsiteHosts(config, old)).toEqual([]);
  expect(previousHostSummary({ ...config, active: { website_host: target } })).toEqual([expect.objectContaining({ host: old, status: 'pending' })]);
});
it('prepares a deep temporary host using its active Pages certificate without a DNS or rule write', async () => {
  const pages = vi.fn().mockResolvedValue({ status: 'active' });
  const [prepared] = await preparePreviousHosts('org', 'default', [old], target, pages, 'account', 'project');
  expect(prepared.redirect).toMatchObject({ hostname: old, certificate_ready: true, requirements: [], rule: { status_code: 301, preserve_query_string: true } });
  expect(mocks.provider.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it('uses noindex fallback when redirect rule access is denied without pretending it was verified', async () => {
  const original = mocks.provider.getMockImplementation()!;
  mocks.provider.mockImplementation(async (route, options) => { if (route.includes('/rulesets')) throw new ProviderError('cloudflare', 403, [10000]); return original(route, options); });
  const [prepared] = await preparePreviousHosts('org', 'default', [old], target, vi.fn().mockResolvedValue({ status: 'active' }), 'account', 'project');
  expect(prepared.redirect).toBeNull();
  expect(prepared.message).toContain('noindex');
});
it('recognizes a real 301 with an identical path and query string', async () => {
  const fetcher = vi.fn(async input => new Response(null, { status: 301, headers: { location: String(input).replace(old, target) } }));
  expect(await checkPreviousHost(old, target, 'publication', fetcher)).toMatchObject({ mode: 'redirect', status: 'verified' });
  expect(String(fetcher.mock.calls[0][0])).toContain('?typeroll_redirect_check=publication');
});
it('accepts noindex fallback only from the exact artifact and reports a visible warning', async () => {
  const fetcher = vi.fn(async () => new Response('page', { headers: { 'x-robots-tag': 'noindex, nofollow', 'x-typeroll-publication': 'publication' } }));
  expect(await checkPreviousHost(old, target, 'publication', fetcher)).toMatchObject({ mode: 'noindex', status: 'warning' });
  await expect(checkPreviousHost(old, target, 'different', fetcher)).rejects.toMatchObject({ code: 'previous_host_unprotected' });
});
it('rejects indexable copies, wrong redirects and redirects that lose query parameters', async () => {
  for (const fetcher of [
    vi.fn(async () => new Response('<meta name="robots" content="index,follow">')),
    vi.fn(async () => new Response(null, { status: 301, headers: { location: `https://${target}/` } })),
    vi.fn(async (input: any) => new Response(null, { status: 301, headers: { location: String(input).replace(old, target).split('?')[0] } })),
  ]) await expect(checkPreviousHost(old, target, 'publication', fetcher)).rejects.toMatchObject({ code: 'previous_host_unprotected' });
});

it('does not mutate DNS or rules on verification-only recovery', async () => {
  const [prepared] = await preparePreviousHosts('org', 'default', [old], target, vi.fn().mockResolvedValue({ status: 'active' }), 'account', 'project');
  mocks.provider.mockClear();
  const fetcher = vi.fn(async (input: any) => new Response(null, { status: 301, headers: { location: String(input).replace(old, target) } }));
  expect(await retirePreviousHosts('org', 'site', 'default', 'publication', [old], target, [prepared], false, fetcher)).toMatchObject([{ status: 'verified' }]);
  expect(mocks.provider).not.toHaveBeenCalled();
});
it('refuses to redirect an address whose DNS changed after approval', async () => {
  const [prepared] = await preparePreviousHosts('org', 'default', [old], target, vi.fn().mockResolvedValue({ status: 'active' }), 'account', 'project');
  mocks.provider.mockReset().mockResolvedValue([{ id: 'other', type: 'CNAME', name: old, content: 'different.pages.dev', proxied: true }]);
  await expect(retirePreviousHosts('org', 'site', 'default', 'publication', [old], target, [prepared], true)).rejects.toMatchObject({ code: 'dns_revision_conflict' });
  expect(mocks.provider.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
it('a provider refusal leaves a verified noindex warning instead of falsely reporting a redirect', async () => {
  const [prepared] = await preparePreviousHosts('org', 'default', [old], target, vi.fn().mockResolvedValue({ status: 'active' }), 'account', 'project');
  const original = mocks.provider.getMockImplementation()!;
  mocks.provider.mockImplementation(async (route, options) => {
    if (options?.method) throw new ProviderError('Cloudflare', 400, [10000]);
    return original(route, options);
  });
  const fetcher = vi.fn(async () => new Response('page', { headers: { 'x-robots-tag': 'noindex, nofollow', 'x-typeroll-publication': 'publication' } }));
  expect(await retirePreviousHosts('org', 'site', 'default', 'publication', [old], target, [prepared], true, fetcher)).toMatchObject([{ mode: 'noindex', status: 'warning' }]);
});
