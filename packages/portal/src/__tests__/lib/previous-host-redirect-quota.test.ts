// Previous website addresses share their hosting zone's Single Redirect quota (Moveria: ten sites
// on sites.moveria.com filled the Free plan, and two later moves went live without a 301 and
// without a reason). Rules are keyed by target, quota and permission problems are reported before
// approval, a refused write is recorded with a repair action, and the repair is idempotent.
import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { ProviderError } from '../../lib/publishing/providers.mjs';
const mocks = vi.hoisted(() => ({ provider: vi.fn(), pages: vi.fn() }));
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: async () => ({ provider: mocks.provider, accountId: 'account', groupId: 'default' }) }));
vi.mock('../../lib/publishing/cloudflare-account-claims', () => ({ assertTrafficNotOwnedByOtherOrganization: async () => {} }));
vi.mock('../../lib/publishing/domain-cutover-journal', () => ({ journaledDomainProvider: (provider: any) => provider, recordDomainCutover: async () => {} }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => mocks.pages }));
vi.mock('../../lib/publishing/cloudflare-capabilities', () => ({ cloudflarePermissionReport: async () => ({ capabilities: [{ capability: 'redirect_rules', status: 'approval_required', next_step: 'Select “Approve update” in Account → Publishing.' }] }) }));
import { preparePreviousHosts, retirePreviousHosts, repairPreviousHostRedirects, legacyPreviousRuleRef, previousRuleRef, previousRuleHosts } from '../../lib/publishing/previous-hosts';
import { withPreviousHostChecks } from '../../lib/publishing/host-checks';
import { siteDomainConfigPath } from '../../lib/publishing/domain-config';

const es = 'site-17e7e9d18e89ce41.sites.moveria.com', target = 'moveria.es';
const targetUrl = (to: string) => `concat("https://${to}", http.request.uri.path)`;
const rule = (ref: string, expression: string, to: string) => ({ ref, expression, action: 'redirect', enabled: true,
  action_parameters: { from_value: { target_url: { expression: targetUrl(to) }, status_code: 301, preserve_query_string: true } } });
/** Ten sites already moved, one legacy per-host rule each, as in moveria.com. */
const tenSites = () => ['se', 'at', 'de', 'nl', 'fi', 'ch', 'fr', 'it', 'no', 'pl'].map(tld => rule(legacyPreviousRuleRef(`site-${tld}.sites.moveria.com`), `http.host eq "site-${tld}.sites.moveria.com"`, `moveria.${tld}`));

/** A Cloudflare zone with an entrypoint quota. Writes are recorded; `fail` refuses selected writes. */
function zone(initial: any[], options: { plan?: string; limit?: number; fail?: (method: string) => Error | null } = {}) {
  const state = { rules: initial.map((item, index) => ({ id: `r${index}`, ...item })) as any[], writes: [] as Array<[string, string, any]>, next: 100 };
  mocks.provider.mockImplementation(async (route: string, request?: { method?: string; body?: any }) => {
    if (route.startsWith('/zones?')) return [{ id: 'zone', name: 'moveria.com', status: 'active', account: { id: 'account' }, plan: { legacy_id: options.plan ?? 'free' } }];
    if (route.includes('/dns_records')) {
      const name = decodeURIComponent(/name=([^&]+)/.exec(route)![1]);
      return [{ id: `dns-${name}`, name, type: 'CNAME', content: 'project.pages.dev', proxied: true }];
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
const covers = (rules: any[], host: string, to: string) => rules.some(item => item.action_parameters.from_value.target_url.expression === targetUrl(to) && previousRuleHosts(item.expression)?.includes(host));
const noindex = vi.fn(async () => new Response('page', { headers: { 'x-robots-tag': 'noindex, nofollow', 'x-typeroll-publication': 'publication' } }));
/** Every previous host answers 301 to `to` with the same path and query. */
const redirected = (to: string) => vi.fn(async (input: any) => { const url = new URL(String(input)); return new Response(null, { status: 301, headers: { location: `https://${to}${url.pathname}${url.search}` } }); });

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  mocks.pages.mockResolvedValue({ status: 'active' });
});

it('reports a full Free plan entrypoint as redirect_rule_quota before approval', async () => {
  zone(tenSites());
  const [prepared] = await preparePreviousHosts('org', 'default', [es], target, mocks.pages, 'account', 'project');
  expect(prepared.issue).toMatchObject({ code: 'redirect_rule_quota', message: expect.stringContaining('10 of 10'), remedy: expect.stringContaining('repair_previous_host_redirects') });
  expect(prepared.issue!.remedy).toContain(`source URL ${es}/, target URL https://${target}/`);
  // The write is still attempted at the switch, in case a rule was freed meanwhile.
  expect(prepared.redirect?.rule).toMatchObject({ ref: previousRuleRef(target), expression: `http.host in {"${es}"}` });
  expect(mocks.provider.mock.calls.every(([, request]) => !request?.method)).toBe(true);
  const checks = withPreviousHostChecks({ checked_at: 'now', hosts: [], blockers: [], warnings: [] }, { state: 'ready_to_switch', previous_host_preparations: [prepared] });
  expect(checks.warnings).toEqual([expect.objectContaining({ code: 'redirect_rule_quota', severity: 'warning', host: es, remedy: expect.any(String) })]);
  // After the switch the issue moves to previous_hosts and the guide; host checks no longer repeat it.
  expect(withPreviousHostChecks({ checked_at: 'now', hosts: [], blockers: [], warnings: [] }, { state: 'live', previous_host_preparations: [prepared] }).warnings).toEqual([]);
});

it('reports a missing redirect permission before approval with the permission update step', async () => {
  const state = zone([]);
  const original = mocks.provider.getMockImplementation()!;
  mocks.provider.mockImplementation(async (route, request) => { if (route.includes('/rulesets')) throw new ProviderError('Cloudflare', 403, [10000]); return original(route, request); });
  const [prepared] = await preparePreviousHosts('org', 'default', [es], target, mocks.pages, 'account', 'project');
  expect(prepared).toMatchObject({ redirect: null, issue: { code: 'redirect_permission_missing', remedy: expect.stringContaining('Approve update') } });
  expect(state.writes).toEqual([]);
});

it('creates one rule per target at the switch and extends it for another previous host of the same site', async () => {
  const state = zone(tenSites(), { plan: 'pro', limit: 25 });
  const older = 'moveria.sites.moveria.com';
  const prepared = await preparePreviousHosts('org', 'default', [es, older], target, mocks.pages, 'account', 'project');
  expect(prepared.map(item => item.issue ?? null)).toEqual([null, null]);
  const result = await retirePreviousHosts('org', 'site', 'default', 'publication', [es, older], target, prepared, true, redirected(target));
  expect(result).toMatchObject([{ host: es, mode: 'redirect', status: 'verified', issue: null }, { host: older, mode: 'redirect' }]);
  expect(state.writes.map(([method]) => method)).toEqual(['POST', 'PATCH']);
  const own = state.rules.filter(item => item.ref === previousRuleRef(target));
  expect(own).toHaveLength(1);
  expect(previousRuleHosts(own[0].expression)).toEqual([older, es].sort());
  expect(state.rules).toHaveLength(11);
});

it('keeps a single legacy per-host rule and merges duplicates for one target only after the merged rule is confirmed', async () => {
  const a = 'site-a.sites.moveria.com', b = 'site-b.sites.moveria.com';
  // One legacy rule already redirects: nothing to write.
  let state = zone([rule(legacyPreviousRuleRef(a), `http.host eq "${a}"`, target)]);
  let [prepared] = await preparePreviousHosts('org', 'default', [a], target, mocks.pages, 'account', 'project');
  expect(prepared.redirect?.rule).toMatchObject({ ref: legacyPreviousRuleRef(a), status: 'configured' });
  await retirePreviousHosts('org', 'site', 'default', 'publication', [a], target, [prepared], true, redirected(target), 'organizations/org/sites/site/deploys/job');
  expect(state.writes).toEqual([]);
  // Two legacy rules for the same target: the maintenance pass merges them, never uncovering a host.
  state = zone([rule(legacyPreviousRuleRef(a), `http.host eq "${a}"`, target), rule(legacyPreviousRuleRef(b), `http.host eq "${b}"`, target), rule('customer', 'http.host eq "shop.moveria.com"', 'example.com')]);
  const original = mocks.provider.getMockImplementation()!;
  const coverage: boolean[] = [];
  mocks.provider.mockImplementation(async (route, request) => {
    const response = await original(route, request);
    if (request?.method) coverage.push(covers(state.rules, a, target) && covers(state.rules, b, target));
    return response;
  });
  [prepared] = await preparePreviousHosts('org', 'default', [b], target, mocks.pages, 'account', 'project');
  for (let run = 0; run < 2; run++) {
    expect(await retirePreviousHosts('org', 'site', 'default', 'publication', [b], target, [prepared], true, redirected(target), 'organizations/org/sites/site/deploys/job'))
      .toMatchObject([{ mode: 'redirect', status: 'verified' }]);
  }
  expect(state.writes.map(([method]) => method)).toEqual(['PATCH', 'DELETE']);
  expect(coverage).toEqual([true, true]);
  expect(state.rules.map(item => item.ref)).toEqual([legacyPreviousRuleRef(a), 'customer']);
  expect(previousRuleHosts(state.rules[0].expression)).toEqual([a, b].sort());
  // A cutover never deletes: rollback could not restore a removed rule.
  state = zone([rule(legacyPreviousRuleRef(a), `http.host eq "${a}"`, target), rule(legacyPreviousRuleRef(b), `http.host eq "${b}"`, target)]);
  [prepared] = await preparePreviousHosts('org', 'default', [b], target, mocks.pages, 'account', 'project');
  await retirePreviousHosts('org', 'site', 'default', 'publication', [b], target, [prepared], true, redirected(target));
  expect(state.writes).toEqual([]);
});

it('records a refused write with a specific issue and the repair action instead of going live silently', async () => {
  const state = zone(tenSites());
  const [prepared] = await preparePreviousHosts('org', 'default', [es], target, mocks.pages, 'account', 'project');
  expect(await retirePreviousHosts('org', 'site', 'default', 'publication', [es], target, [prepared], true, noindex)).toMatchObject([{
    host: es, mode: 'noindex', status: 'warning', issue: { code: 'redirect_rule_quota' }, next_action: 'repair_previous_host_redirects', message: expect.stringContaining('10 of 10'),
  }]);
  expect(state.writes.map(([method]) => method)).toEqual(['POST']);
  // A permission refusal at the switch is its own code; a provider outage is retried by the job instead.
  zone([], { fail: () => new ProviderError('Cloudflare', 403, [10000]) });
  const [fresh] = await preparePreviousHosts('org', 'default', [es], target, mocks.pages, 'account', 'project');
  expect(await retirePreviousHosts('org', 'site', 'default', 'publication', [es], target, [fresh], true, noindex)).toMatchObject([{ issue: { code: 'redirect_permission_missing' }, next_action: 'repair_previous_host_redirects' }]);
  zone([], { fail: () => new ProviderError('Cloudflare', 502, []) });
  await expect(retirePreviousHosts('org', 'site', 'default', 'publication', [es], target, [fresh], true, noindex)).rejects.toMatchObject({ status: 502 });
});

it('repairs the missing redirect of a live site idempotently, without a build or DNS change', async () => {
  const store = getStore();
  await store.setDoc(siteDomainConfigPath('org', 'site'), {
    revision: 'rev', desired: { website_host: target, media_host: null, media_path_prefix: '' }, active: { website_host: target, media_host: null, media_path_prefix: '' },
    published: { hosts: { website_host: target, media_host: null, media_path_prefix: '' }, dns_mode: 'automatic', publication_id: 'publication', job_id: 'job' },
    media_aliases: [{ website_host: es, media_host: null, media_path_prefix: '' }], dns_mode: 'automatic', state: 'live',
    previous_hosts: [{ host: es, target_host: target, mode: 'noindex', status: 'warning', message: 'Its 301 redirect still needs attention.' }],
  });
  await store.setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { job_id: null, lease_id: null, lease_until: 0,
    last_publication: { publication_id: 'publication', website_host: target, account_id: 'account', project: 'project', hosting_group_id: 'default' } });
  // Still full: the repair reports the quota and changes nothing it should not.
  let state = zone(tenSites());
  expect(await repairPreviousHostRedirects('org', 'site', noindex)).toMatchObject({ repaired: [], remaining: [{ host: es, issue: { code: 'redirect_rule_quota' } }] });
  expect((await store.getDoc<any>(siteDomainConfigPath('org', 'site'))).previous_hosts).toMatchObject([{ host: es, issue: { code: 'redirect_rule_quota' }, next_action: 'repair_previous_host_redirects' }]);
  // After the customer frees a rule (or upgrades), the same action creates it; repeating it writes nothing.
  state = zone(tenSites().slice(1));
  const fetcher = redirected(target);
  expect(await repairPreviousHostRedirects('org', 'site', fetcher)).toMatchObject({ repaired: [es], remaining: [] });
  expect(await repairPreviousHostRedirects('org', 'site', fetcher)).toMatchObject({ repaired: [es], remaining: [] });
  expect(state.writes.map(([method]) => method)).toEqual(['POST']);
  expect(mocks.provider.mock.calls.some(([route, request]) => route.includes('/dns_records') && request?.method)).toBe(false);
  expect((await store.getDoc<any>(siteDomainConfigPath('org', 'site'))).previous_hosts).toMatchObject([{ host: es, mode: 'redirect', status: 'verified', issue: null }]);
  // Not while a publication runs, and not before the site is live.
  await store.updateDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { job_id: 'running' });
  await expect(repairPreviousHostRedirects('org', 'site', fetcher)).rejects.toMatchObject({ code: 'publication_in_progress' });
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { state: 'ready_to_switch' });
  await expect(repairPreviousHostRedirects('org', 'site', fetcher)).rejects.toMatchObject({ code: 'previous_host_repair_unavailable' });
});
