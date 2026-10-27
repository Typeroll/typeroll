import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { journaledDomainProvider, armDomainCutover, recordDomainCutover, rollbackDomainCutover, readDomainCutover } from '../../lib/publishing/domain-cutover-journal';
import { getSiteDomains, siteDomainConfigPath } from '../../lib/publishing/domain-config';
import { applyPreparedTraffic, trafficFingerprint } from '../../lib/publishing/domain-provider';
const provider = vi.hoisted(() => vi.fn());
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: async () => ({ provider, accountId: 'account', groupId: 'default' }) }));
let records: any[];
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); provider.mockReset();
  records = [{ id: 'original', type: 'A', name: 'www.example.com', content: '192.0.2.25', ttl: 300, proxied: false, comment: 'Keep this comment', tags: ['owner:customer'], settings: {} }];
  provider.mockImplementation(async (route, options) => {
    if (!options?.method) return structuredClone(records);
    if (options.method === 'PATCH' || options.method === 'PUT') { records = [{ ...(options.method === 'PATCH' ? records[0] : { id: 'original' }), ...options.body }]; return structuredClone(records[0]); }
    if (options.method === 'DELETE') { records = []; return {}; }
    throw new Error('Unexpected provider mutation');
  });
});
afterEach(() => vi.restoreAllMocks());
async function prepare() {
  const config = await getSiteDomains('org', 'site');
  const preparation = { hostname: 'www.example.com', zone_id: 'zone', provider_status: 'active', certificate_ready: true, dns_fingerprint: trafficFingerprint(records), previous_records: structuredClone(records), action: 'approve_cutover' as const,
    requirements: [{ phase: 'traffic' as const, type: 'CNAME' as const, name: 'www.example.com', content: 'site.pages.dev', status: 'required' as const, proxied: true }] };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { state: 'distributing', candidate: { id: 'candidate', revision: config.revision }, active: { website_host: 'old.example.com', media_host: null, media_path_prefix: '' }, approved_preparation: preparation, cutover_approved_revision: config.revision });
  return { config: await getSiteDomains('org', 'site'), preparation };
}
it('persists the baseline before any mutation and restores all writable record fields idempotently', async () => {
  const before = structuredClone(records), { config, preparation } = await prepare();
  await armDomainCutover('org', 'site', 'default', config);
  expect(provider.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  await applyPreparedTraffic(provider, preparation);
  await recordDomainCutover('org', 'site', 'candidate', 'www.example.com');
  expect((await readDomainCutover('org', 'site', 'candidate'))?.entries[0].before).toEqual(before);
  expect(await rollbackDomainCutover('org', 'site', 'candidate')).toMatchObject({ state: 'rolled_back', errors: [] });
  expect(records).toEqual(before);
  const writes = provider.mock.calls.filter(([, options]) => options?.method).length;
  await rollbackDomainCutover('org', 'site', 'candidate');
  expect(provider.mock.calls.filter(([, options]) => options?.method)).toHaveLength(writes);
});
it('refuses to overwrite an intervening DNS edit', async () => {
  const { config, preparation } = await prepare();
  await armDomainCutover('org', 'site', 'default', config); await applyPreparedTraffic(provider, preparation);
  await recordDomainCutover('org', 'site', 'candidate', 'www.example.com');
  records[0].comment = 'Changed by another administrator';
  expect(await rollbackDomainCutover('org', 'site', 'candidate')).toMatchObject({ state: 'conflict', errors: [expect.stringContaining('DNS differs')] });
  expect(records[0].comment).toBe('Changed by another administrator');
});
it('does not treat a lost write response as permission to overwrite unknown DNS', async () => {
  const { config, preparation } = await prepare();
  await armDomainCutover('org', 'site', 'default', config); await applyPreparedTraffic(provider, preparation);
  expect(await rollbackDomainCutover('org', 'site', 'candidate')).toMatchObject({ state: 'conflict' });
});
it('rejects DNS changes after approval before arming the switch', async () => {
  const { config } = await prepare(); records[0].content = '192.0.2.26';
  await expect(armDomainCutover('org', 'site', 'default', config)).rejects.toMatchObject({ code: 'dns_revision_conflict' });
  expect(await readDomainCutover('org', 'site', 'candidate')).toBeNull();
});

it('recovers its own DNS write after a lost response and restores the baseline', async () => {
  const before = structuredClone(records), { config, preparation } = await prepare();
  await armDomainCutover('org', 'site', 'default', config);
  const wrapped = journaledDomainProvider(provider, 'org', 'site', 'candidate', 'www.example.com');
  const actual = provider.getMockImplementation()!;
  provider.mockImplementation(async (route, options) => { const result = await actual(route, options); if (options?.method === 'PATCH') throw new Error('response lost'); return result; });
  await expect(applyPreparedTraffic(wrapped, preparation)).rejects.toThrow('response lost');
  expect(await rollbackDomainCutover('org', 'site', 'candidate')).toMatchObject({ state: 'rolled_back' });
  expect(records).toEqual(before);
});

it('rejects a changed TTL after approval, before recording or changing traffic', async () => {
  const { config } = await prepare(); records[0].ttl = 600;
  await expect(armDomainCutover('org', 'site', 'default', config)).rejects.toMatchObject({ code: 'dns_revision_conflict' });
});
it('does not roll back a newer publication or restore its metadata', async () => {
  const { config, preparation } = await prepare();
  await armDomainCutover('org', 'site', 'default', config); await applyPreparedTraffic(provider, preparation);
  await recordDomainCutover('org', 'site', 'candidate', 'www.example.com');
  await getStore().setDoc('organizations/org/sites/site/publishing_targets/main', { last_publication: { publication_id: 'later' } });
  const before = structuredClone(records);
  await expect(rollbackDomainCutover('org', 'site', 'candidate')).rejects.toMatchObject({ code: 'cutover_superseded' });
  expect(records).toEqual(before);
});
it('recovers a newly created redirect rule after the response is lost without deleting other rules', async () => {
  const { config } = await prepare();
  const redirect: any = { ...config.approved_preparation, target_host: 'example.com', rule: { ref: 'typeroll-redirect', status: 'required' } };
  config.approved_preparation = null; config.approved_redirect_preparations = [redirect];
  let currentRules: any = { id: 'ruleset', rules: [{ id: 'unrelated', ref: 'customer-rule' }] };
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (route, options) => {
    if (!route.includes('/rulesets')) return original(route, options);
    if (!options?.method) return structuredClone(currentRules);
    if (options.method === 'POST') { currentRules.rules.push({ id: 'new-rule', ...options.body }); throw new Error('lost rule response'); }
    if (options.method === 'DELETE') { currentRules.rules = currentRules.rules.filter((rule: any) => rule.id !== route.split('/').pop()); return {}; }
    throw new Error('Unexpected rule write');
  });
  await armDomainCutover('org', 'site', 'default', config);
  const wrapped = journaledDomainProvider(provider, 'org', 'site', 'candidate', 'www.example.com');
  await expect(wrapped('/zones/zone/rulesets/ruleset/rules', { method: 'POST', body: { ref: redirect.rule.ref, expression: 'http.host eq "www.example.com"', action: 'redirect', enabled: true, action_parameters: { from_value: { target_url: { value: 'https://example.com' }, status_code: 301 } } } })).rejects.toThrow('lost rule response');
  expect(await rollbackDomainCutover('org', 'site', 'candidate')).toMatchObject({ state: 'rolled_back' });
  expect(currentRules.rules).toEqual([{ id: 'unrelated', ref: 'customer-rule' }]);
});

it.each([false, true])('handles CNAME-to-A normalization and rollback, lost response: %s', async lostResponse => {
  records[0] = { ...records[0], type: 'CNAME', content: 'old.cloudfront.net', settings: { flatten_cname: false } };
  const before = structuredClone(records), { config } = await prepare();
  await armDomainCutover('org', 'site', 'default', config);
  const wrapped = journaledDomainProvider(provider, 'org', 'site', 'candidate', 'www.example.com');
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (route, options) => {
    const result = await original(route, options);
    if (options?.method === 'PATCH' && options.body.type === 'A') {
      records[0].settings = {};
      if (lostResponse) throw Error('response lost');
      return structuredClone(records[0]);
    }
    return result;
  });
  const write = wrapped('/zones/zone/dns_records/original', { method: 'PATCH', body: { type: 'A', name: 'www.example.com', content: '192.0.2.1', proxied: true, ttl: 1 } });
  if (lostResponse) await expect(write).rejects.toThrow('response lost'); else {
    await write;
    await recordDomainCutover('org', 'site', 'candidate', 'www.example.com');
  }
  expect(await rollbackDomainCutover('org', 'site', 'candidate')).toMatchObject({ state: 'rolled_back', errors: [] });
  expect(records).toEqual(before);
});

it('still rejects unrelated setting changes during CNAME-to-A conversion', async () => {
  records[0] = { ...records[0], type: 'CNAME', content: 'old.cloudfront.net', settings: { flatten_cname: false } };
  const { config } = await prepare();
  await armDomainCutover('org', 'site', 'default', config);
  const wrapped = journaledDomainProvider(provider, 'org', 'site', 'candidate', 'www.example.com');
  await wrapped('/zones/zone/dns_records/original', { method: 'PATCH', body: { type: 'A', name: 'www.example.com', content: '192.0.2.1', proxied: true, ttl: 1 } });
  records[0].settings = { ipv4_only: true };
  await expect(recordDomainCutover('org', 'site', 'candidate', 'www.example.com')).rejects.toMatchObject({ code: 'dns_revision_conflict' });
  expect(await rollbackDomainCutover('org', 'site', 'candidate')).toMatchObject({ state: 'conflict' });
  expect(records[0].settings).toEqual({ ipv4_only: true });
});
