// The www counterpart of the website host redirects to it by default (autopilot.se served the
// site directly while app backends only allowed https://www.autopilot.se, so every app call on the
// apex got 403). Derived, never stored as input; opt-out per site; never takes over a host that
// serves something else; only the zone's redirect rule is written, never DNS.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { ProviderError } from '../../lib/publishing/providers.mjs';
const mocks = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: async () => ({ provider: mocks.provider, accountId: 'account', groupId: 'default' }) }));
vi.mock('../../lib/publishing/cloudflare-account-claims', () => ({ assertTrafficNotOwnedByOtherOrganization: async () => {} }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => mocks.provider }));
vi.mock('../../lib/publishing/cloudflare-capabilities', () => ({ cloudflarePermissionReport: async () => ({ capabilities: [{ capability: 'redirect_rules', status: 'approval_required', next_step: 'Select “Approve update” in Account → Publishing.' }] }) }));
import { wwwCounterpart, implicitRedirectHosts, implicitRedirectsPending, withImplicitRedirects, implicitRedirectCheckItems, maintainImplicitRedirects, counterpartUse, type ImplicitRedirectContext } from '../../lib/publishing/www-redirect';
import { legacyPreviousRuleRef, previousRuleRef, previousRuleHosts, repairPreviousHostRedirects } from '../../lib/publishing/previous-hosts';
import { getSiteDomains, saveSiteDomains, siteDomainConfigPath, type DomainConfiguration } from '../../lib/publishing/domain-config';
import { domainChangeImpact } from '../../lib/publishing/domain-impact';

const target = 'www.autopilot.se', apex = 'autopilot.se', project = 'autopilot-site';
const hosts = (extra: Partial<DomainConfiguration['desired']> = {}) => ({ website_host: target, media_host: null, media_path_prefix: '', ...extra });
const targetUrl = (to: string) => `concat("https://${to}", http.request.uri.path)`;
const rule = (ref: string, expression: string, to: string) => ({ ref, expression, action: 'redirect', enabled: true,
  action_parameters: { from_value: { target_url: { expression: targetUrl(to) }, status_code: 301, preserve_query_string: true } } });

type DnsRecord = { type: string; content: string; proxied: boolean };
/**
 * A Cloudflare zone autopilot.se: `records` are the counterpart's DNS records, `rules` the redirect
 * entrypoint. The public side answers 301 for every host a rule lists, as Cloudflare's edge would.
 */
function zone(options: { records?: DnsRecord[]; rules?: any[]; plan?: string; limit?: number; fail?: (method: string) => Error | null; zoneName?: string } = {}) {
  const name = options.zoneName ?? apex;
  const state = { rules: (options.rules ?? []).map((item, index) => ({ id: `r${index}`, ...item })) as any[], writes: [] as Array<[string, string, any]>, next: 100 };
  mocks.provider.mockImplementation(async (route: string, request?: { method?: string; body?: any }) => {
    if (route.startsWith('/zones?')) {
      const query = new URL(`https://api.invalid${route}`).searchParams.get('name');
      return query === name ? [{ id: 'zone', name, status: 'active', account: { id: 'account' }, plan: { legacy_id: options.plan ?? 'free' } }] : [];
    }
    if (route.includes('/dns_records')) {
      if (request?.method) throw new Error('DNS must not change');
      const host = decodeURIComponent(/name=([^&]+)/.exec(route)![1]);
      return (options.records ?? []).map((record, index) => ({ id: `dns-${index}`, name: host, ttl: 1, ...record }));
    }
    if (!request?.method) return route.endsWith('/entrypoint') ? { id: 'rs', rules: structuredClone(state.rules) } : null;
    state.writes.push([request.method, route, request.body]);
    const failure = options.fail?.(request.method);
    if (failure) throw failure;
    const id = route.split('/').pop();
    if (request.method === 'POST') {
      if (state.rules.length >= (options.limit ?? 10)) throw new ProviderError('Cloudflare', 400, [20217]);
      state.rules.push({ ...(request.body.rules?.[0] ?? request.body), id: `r${state.next++}` });
    } else if (request.method === 'PATCH') state.rules = state.rules.map(item => item.id === id ? { ...request.body, id } : item);
    else if (request.method === 'DELETE') state.rules = state.rules.filter(item => item.id !== id);
    return {};
  });
  return state;
}
/** The public edge: a host listed in an enabled redirect rule answers 301; anything else serves the site (200). */
function edge(state: { rules: any[] }) {
  return vi.fn(async (input: any) => {
    const url = new URL(String(input));
    const match = state.rules.find(item => item.enabled !== false && previousRuleHosts(item.expression)?.includes(url.hostname));
    if (!match) return new Response('site', { status: 200 });
    const to = /concat\("https:\/\/([^"]+)"/.exec(match.action_parameters.from_value.target_url.expression)![1];
    return new Response(null, { status: 301, headers: { location: `https://${to}${url.pathname}${url.search}` } });
  });
}
const pagesRecord: DnsRecord = { type: 'CNAME', content: `${project}.pages.dev`, proxied: true };
function context(overrides: Partial<ImplicitRedirectContext> = {}): ImplicitRedirectContext {
  return { org: 'org', site: 'site', group: 'default', publicationId: 'publication-0123456789', target, dnsMode: 'automatic', project,
    config: {}, hosts: hosts(), exclude: [], jobPath: 'organizations/org/sites/site/deploys/job', ...overrides };
}

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks(); });

describe('derivation', () => {
  it('pairs an apex with its www host and nothing else', () => {
    expect(wwwCounterpart('www.example.com')).toBe('example.com');
    expect(wwwCounterpart('example.com')).toBe('www.example.com');
    expect(wwwCounterpart('shop.example.com')).toBeNull();
    expect(wwwCounterpart('www.shop.example.com')).toBeNull();
    expect(wwwCounterpart('site-1.sites.example.com')).toBeNull();
    expect(wwwCounterpart('WWW.Example.COM')).toBe('example.com');
    expect(wwwCounterpart('Example.com.')).toBe('www.example.com');
    expect(wwwCounterpart(null)).toBeNull();
    expect(wwwCounterpart('')).toBeNull();
  });

  it('derives internationalized names in punycode', () => {
    expect(wwwCounterpart('exämple.se')).toBe('www.xn--exmple-cua.se');
    expect(wwwCounterpart('www.xn--exmple-cua.se')).toBe('xn--exmple-cua.se');
    expect(wwwCounterpart('WWW.EXÄMPLE.SE')).toBe('xn--exmple-cua.se');
  });

  it('uses the zone to tell an apex under a multi-label suffix from a subdomain', () => {
    expect(wwwCounterpart('example.co.uk')).toBeNull();
    expect(wwwCounterpart('example.co.uk', 'example.co.uk')).toBe('www.example.co.uk');
    expect(wwwCounterpart('www.example.co.uk', 'example.co.uk')).toBe('example.co.uk');
    expect(wwwCounterpart('shop.example.com', 'example.com')).toBeNull();
    expect(wwwCounterpart('www.shop.example.com', 'example.com')).toBeNull();
    expect(wwwCounterpart('www.shop.example.com', 'shop.example.com')).toBe('shop.example.com');
  });

  it('merges with explicit redirect hosts, the media host and previous hosts without duplicates, and honours the opt-out', () => {
    expect(implicitRedirectHosts({}, hosts())).toEqual([apex]);
    expect(implicitRedirectHosts({ www_redirect: false }, hosts())).toEqual([]);
    expect(implicitRedirectHosts({}, hosts({ redirect_hosts: [apex] }))).toEqual([]);
    expect(implicitRedirectHosts({}, hosts({ redirect_hosts: ['old.autopilot.se'] }))).toEqual([apex]);
    expect(implicitRedirectHosts({}, hosts({ media_host: apex }))).toEqual([]);
    expect(implicitRedirectHosts({}, hosts(), [apex])).toEqual([]);
    expect(implicitRedirectHosts({}, { website_host: 'shop.example.com', media_host: null, media_path_prefix: '' })).toEqual([]);
    // A host derived with the zone at publication stays visible in reads.
    const recorded = [{ host: 'example.co.uk', target_host: 'www.example.co.uk', source: 'default' as const, status: 'verified' as const, message: '', issue: null, next_action: null }];
    expect(implicitRedirectHosts({ implicit_redirects: recorded }, { website_host: 'www.example.co.uk', media_host: null, media_path_prefix: '' })).toEqual(['example.co.uk']);
    expect(implicitRedirectHosts({ implicit_redirects: [{ ...recorded[0], host: apex }] }, hosts())).toEqual([apex]);
  });

  it('shows the implicit host in reads, marked as the default and never as explicit input', () => {
    const config = { revision: 'r', desired: hosts(), active: hosts(), media_aliases: [], dns_mode: 'automatic', state: 'live' } as DomainConfiguration;
    const read = withImplicitRedirects(config);
    expect(read).toMatchObject({ www_redirect: true, desired: { implicit_redirect_hosts: [apex] }, active: { implicit_redirect_hosts: [apex] },
      implicit_redirects: [{ host: apex, target_host: target, source: 'default', status: 'planned', next_action: null }] });
    expect(read.desired.redirect_hosts).toBeUndefined();
    expect(read.implicit_redirects[0].message).toContain('repair_previous_host_redirects');
    const off = withImplicitRedirects({ ...config, www_redirect: false });
    expect(off).toMatchObject({ www_redirect: false, implicit_redirects: [] });
    expect(off.desired).not.toHaveProperty('implicit_redirect_hosts');
    // Before go-live the status refers to the saved future host.
    expect(withImplicitRedirects({ ...config, active: null, state: 'declared' }).implicit_redirects[0].message).toContain(`After the site is live at ${target}`);
    // Recorded problems are host_checks warnings, never blockers.
    const issue = { code: 'www_redirect_host_in_use' as const, message: 'in use', remedy: 'remedy' };
    const warned = { ...config, implicit_redirects: [{ host: apex, target_host: target, source: 'default' as const, status: 'warning' as const, message: 'in use', issue, next_action: null }] };
    expect(implicitRedirectCheckItems(warned)).toEqual([{ code: 'www_redirect_host_in_use', severity: 'warning', host: apex, message: 'in use', remedy: 'remedy' }]);
    expect(implicitRedirectsPending(config, hosts())).toBe(true);
    expect(implicitRedirectsPending(warned, hosts())).toBe(true);
    expect(implicitRedirectsPending({ implicit_redirects: [{ ...warned.implicit_redirects[0], status: 'verified', issue: null }] }, hosts())).toBe(false);
    expect(implicitRedirectsPending({ www_redirect: false, implicit_redirects: [] }, hosts())).toBe(false);
  });

  it('classifies who a counterpart serves from its records', () => {
    expect(counterpartUse([], project)).toBe('missing');
    expect(counterpartUse([pagesRecord], project)).toBe('same_site');
    expect(counterpartUse([{ type: 'CNAME', content: 'AUTOPILOT-SITE.pages.dev.', proxied: true }], project)).toBe('same_site');
    expect(counterpartUse([{ type: 'A', content: '192.0.2.1', proxied: true }, { type: 'AAAA', content: '100::', proxied: true }], project)).toBe('redirect_only');
    expect(counterpartUse([{ type: 'CNAME', content: 'other-project.pages.dev', proxied: true }], project)).toBe('other');
    expect(counterpartUse([{ ...pagesRecord, proxied: false }], project)).toBe('other');
    expect(counterpartUse([{ type: 'A', content: '203.0.113.7', proxied: true }], project)).toBe('other');
  });
});

describe('publication with automatic DNS', () => {
  it('adds the counterpart attached to the same Pages project to the redirect rule, once, without DNS changes', async () => {
    const state = zone({ records: [pagesRecord] });
    const fetchImpl = edge(state);
    const [first] = await maintainImplicitRedirects(context({ fetchImpl }));
    expect(first).toMatchObject({ host: apex, target_host: target, source: 'default', status: 'verified', issue: null, managed_rule: { zone_id: 'zone', zone_name: apex } });
    expect(state.writes.map(([method]) => method)).toEqual(['POST']);
    expect(state.rules).toEqual([expect.objectContaining({ ref: previousRuleRef(target), expression: `http.host in {"${apex}"}`,
      action_parameters: { from_value: { target_url: { expression: targetUrl(target) }, status_code: 301, preserve_query_string: true } } })]);
    // The write was journaled before it was submitted.
    expect(await getStore().getDoc(`organizations/org/sites/site/deploys/job/previous_host_writes/${previousRuleRef(target)}`)).toMatchObject({ state: 'submitted', hostname: apex });
    // The next publication sees the 301 and writes nothing.
    const [second] = await maintainImplicitRedirects(context({ fetchImpl, config: { implicit_redirects: [first] } }));
    expect(second).toMatchObject({ status: 'verified', managed_rule: { zone_id: 'zone' } });
    expect(state.writes).toHaveLength(1);
    expect(mocks.provider.mock.calls.some(([route, request]) => route.includes('/dns_records') && request?.method)).toBe(false);
  });

  it('extends the existing rule of the website host instead of using another rule slot', async () => {
    const old = 'site-1.sites.autopilot.se';
    const state = zone({ records: [{ type: 'A', content: '192.0.2.1', proxied: true }], rules: [rule(previousRuleRef(target), `http.host in {"${old}"}`, target)] });
    const [result] = await maintainImplicitRedirects(context({ fetchImpl: edge(state), exclude: [old] }));
    expect(result.status).toBe('verified');
    expect(state.writes.map(([method]) => method)).toEqual(['PATCH']);
    expect(state.rules).toHaveLength(1);
    expect(previousRuleHosts(state.rules[0].expression)).toEqual([apex, old].sort());
  });

  it('derives the counterpart under a multi-label suffix from the zone', async () => {
    const state = zone({ records: [pagesRecord], zoneName: 'example.co.uk' });
    const [result] = await maintainImplicitRedirects(context({ target: 'www.example.co.uk', hosts: { website_host: 'www.example.co.uk', media_host: null, media_path_prefix: '' }, fetchImpl: edge(state) }));
    expect(result).toMatchObject({ host: 'example.co.uk', target_host: 'www.example.co.uk', status: 'verified' });
    // A plain subdomain gets nothing implicit, and is never checked publicly.
    const fetchImpl = edge(state);
    expect(await maintainImplicitRedirects(context({ target: 'shop.example.co.uk', hosts: { website_host: 'shop.example.co.uk', media_host: null, media_path_prefix: '' }, fetchImpl }))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never takes over a counterpart that serves something else', async () => {
    for (const records of [[{ type: 'A', content: '203.0.113.7', proxied: false }], [{ type: 'CNAME', content: 'another-site.pages.dev', proxied: true }], [{ ...pagesRecord, proxied: false }]]) {
      const state = zone({ records });
      const [result] = await maintainImplicitRedirects(context({ fetchImpl: edge(state) }));
      expect(result).toMatchObject({ status: 'warning', next_action: null, managed_rule: null, issue: { code: 'www_redirect_host_in_use', remedy: expect.stringContaining('www_redirect: false') } });
      expect(result.message).toContain(records[0].content);
      expect(state.writes).toEqual([]);
    }
  });

  it('does not override another rule that sends the counterpart elsewhere', async () => {
    const state = zone({ records: [pagesRecord], rules: [rule('customer', `http.host eq "${apex}"`, 'shop.example.com')] });
    const [result] = await maintainImplicitRedirects(context({ fetchImpl: vi.fn(async () => new Response('site')) }));
    expect(result).toMatchObject({ status: 'warning', issue: { code: 'redirect_rule_conflict' } });
    expect(state.writes).toEqual([]);
  });

  it('reports a missing record with instructions and creates nothing', async () => {
    const state = zone({ records: [] });
    const [result] = await maintainImplicitRedirects(context({ fetchImpl: vi.fn(async () => { throw new TypeError('getaddrinfo ENOTFOUND'); }) }));
    expect(result).toMatchObject({ status: 'warning', issue: { code: 'www_redirect_record_missing', remedy: expect.stringContaining('192.0.2.1') } });
    expect(state.writes).toEqual([]);
  });

  it('reports a full rule quota without writing, and creates the rule once a slot is free', async () => {
    const full = Array.from({ length: 10 }, (_, index) => rule(legacyPreviousRuleRef(`site-${index}.sites.autopilot.se`), `http.host eq "site-${index}.sites.autopilot.se"`, `site${index}.example`));
    let state = zone({ records: [pagesRecord], rules: full });
    const [blocked] = await maintainImplicitRedirects(context({ fetchImpl: edge(state) }));
    expect(blocked).toMatchObject({ status: 'warning', next_action: 'repair_previous_host_redirects', issue: { code: 'redirect_rule_quota', remedy: expect.stringContaining('repair_previous_host_redirects') } });
    expect(blocked.message).toContain('10 of 10');
    expect(blocked.message).toContain('serves the site directly');
    expect(state.writes).toEqual([]);
    state = zone({ records: [pagesRecord], rules: full.slice(1) });
    expect((await maintainImplicitRedirects(context({ fetchImpl: edge(state), config: { implicit_redirects: [blocked] } })))[0]).toMatchObject({ status: 'verified' });
    expect(state.writes.map(([method]) => method)).toEqual(['POST']);
  });

  it('turns refusals and outages into warnings instead of failing the publication', async () => {
    let state = zone({ records: [pagesRecord], fail: () => new ProviderError('Cloudflare', 403, [10000]) });
    expect((await maintainImplicitRedirects(context({ fetchImpl: edge(state) })))[0]).toMatchObject({ status: 'warning', issue: { code: 'redirect_permission_missing', remedy: expect.stringContaining('Approve update') }, next_action: 'repair_previous_host_redirects' });
    state = zone({ records: [pagesRecord], fail: () => new ProviderError('Cloudflare', 400, [20217]) });
    expect((await maintainImplicitRedirects(context({ fetchImpl: edge(state) })))[0]).toMatchObject({ status: 'warning', issue: { code: 'redirect_rule_rejected' } });
    state = zone({ records: [pagesRecord], fail: () => new ProviderError('Cloudflare', 502, []) });
    expect((await maintainImplicitRedirects(context({ fetchImpl: edge(state) })))[0]).toMatchObject({ status: 'warning', issue: { code: 'www_redirect_unavailable' }, next_action: 'repair_previous_host_redirects' });
  });

  it('removes the host from its rule after an opt-out, keeping the other hosts', async () => {
    const old = 'site-1.sites.autopilot.se';
    const state = zone({ records: [pagesRecord], rules: [rule(previousRuleRef(target), `http.host in {"${apex}" "${old}"}`, target)] });
    const managed = { host: apex, target_host: target, source: 'default' as const, status: 'verified' as const, message: '', issue: null, next_action: null, managed_rule: { zone_id: 'zone', zone_name: apex } };
    const fetchImpl = edge(state);
    expect(await maintainImplicitRedirects(context({ fetchImpl, exclude: [old], config: { www_redirect: false, implicit_redirects: [managed] } }))).toEqual([]);
    expect(state.writes.map(([method]) => method)).toEqual(['PATCH']);
    expect(previousRuleHosts(state.rules[0].expression)).toEqual([old]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('publication with external DNS', () => {
  it('verifies an existing redirect and otherwise reports the record and rule to create, without provider calls', async () => {
    const redirected = vi.fn(async (input: any) => { const url = new URL(String(input)); return new Response(null, { status: 301, headers: { location: `https://${target}${url.pathname}${url.search}` } }); });
    expect(await maintainImplicitRedirects(context({ dnsMode: 'external', fetchImpl: redirected }))).toMatchObject([{ status: 'verified' }]);
    const [missing] = await maintainImplicitRedirects(context({ dnsMode: 'external', fetchImpl: vi.fn(async () => new Response('site')) }));
    expect(missing).toMatchObject({ status: 'warning', next_action: null, issue: { code: 'www_redirect_external_dns', remedy: expect.stringContaining(`http.host eq "${apex}"`) } });
    expect(missing.message).toContain('HTTP 200');
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});

describe('settings and repair', () => {
  const live = { revision: 'rev', desired: hosts(), active: hosts(), published: { hosts: hosts(), dns_mode: 'automatic', publication_id: 'publication', job_id: 'job' },
    media_aliases: [], dns_mode: 'automatic', state: 'live', candidate: { id: 'publication', revision: 'rev', commit: 'c', deployment_id: 'd', verified_at: 'now' } };

  it('saves the opt-out without changing the revision, state or a pending approval', async () => {
    await getStore().setDoc(siteDomainConfigPath('org', 'site'), { ...live, state: 'ready_to_switch', cutover_approved_revision: null });
    expect(await domainChangeImpact('org', 'site', { revision: 'rev', website_host: target, dns_mode: 'automatic', www_redirect: false })).toMatchObject({ changed: true, requires_candidate: false, message: expect.stringContaining('Only the www redirect') });
    const saved = await saveSiteDomains('org', 'site', { revision: 'rev', website_host: target, dns_mode: 'automatic', www_redirect: false });
    expect(saved).toMatchObject({ revision: 'rev', state: 'ready_to_switch', www_redirect: false, candidate: { id: 'publication' } });
    // Omitting the field keeps the saved value; strings from forms are accepted.
    expect(await saveSiteDomains('org', 'site', { revision: 'rev', website_host: target, dns_mode: 'automatic' })).toMatchObject({ www_redirect: false });
    expect(await saveSiteDomains('org', 'site', { revision: 'rev', website_host: target, dns_mode: 'automatic', www_redirect: 'true' })).toMatchObject({ revision: 'rev', www_redirect: true });
    await expect(saveSiteDomains('org', 'site', { revision: 'rev', website_host: target, dns_mode: 'automatic', www_redirect: 'maybe' })).rejects.toMatchObject({ status: 400, code: 'invalid_www_redirect' });
    await expect(saveSiteDomains('org', 'site', { revision: 'stale', website_host: target, dns_mode: 'automatic', www_redirect: false })).rejects.toMatchObject({ code: 'domain_revision_conflict' });
  });

  it('creates the redirect of a live site through repair_previous_host_redirects, idempotently and without a build or DNS change', async () => {
    await getStore().setDoc(siteDomainConfigPath('org', 'site'), live);
    await getStore().setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { job_id: null, lease_id: null, lease_until: 0,
      last_publication: { publication_id: 'publication', website_host: target, account_id: 'account', project, hosting_group_id: 'default' } });
    const state = zone({ records: [pagesRecord] });
    const fetchImpl = edge(state);
    expect(await repairPreviousHostRedirects('org', 'site', fetchImpl)).toMatchObject({ repaired: [], remaining: [], implicit_redirects: [{ host: apex, status: 'verified' }] });
    expect(await repairPreviousHostRedirects('org', 'site', fetchImpl)).toMatchObject({ implicit_redirects: [{ host: apex, status: 'verified' }] });
    expect(state.writes.map(([method]) => method)).toEqual(['POST']);
    expect((await getSiteDomains('org', 'site')).implicit_redirects).toMatchObject([{ host: apex, target_host: target, source: 'default', status: 'verified' }]);
    expect(mocks.provider.mock.calls.some(([route, request]) => route.includes('/dns_records') && request?.method)).toBe(false);
  });
});
