import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { checkPublicationHosts, assertHostChecks, type ZoneSource } from '../../lib/publishing/host-checks';
import { parsePublicationHosts } from '../../lib/publishing/domain-config';

const mocks = vi.hoisted(() => ({ cloudflare: vi.fn() }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => mocks.cloudflare }));

const HOSTING = 'a'.repeat(32), ORGANIZATION = 'b'.repeat(32);
/** Synthetic Cloudflare zone listing: `zones` maps a zone name to its status in one account. */
function zoneProvider(accountId: string, zones: Record<string, string>) {
  return vi.fn(async (route: string) => {
    const name = new URL(`https://api.invalid${route}`).searchParams.get('name');
    return zones[name!] ? [{ id: `zone-${name}`, name, status: zones[name!], account: { id: accountId }, name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] }] : [];
  });
}
const source = (account: ZoneSource['account'], accountId: string, zones: Record<string, string>): ZoneSource => ({ account, accountId, provider: zoneProvider(accountId, zones) });

describe('future host checks before preparation', () => {
  it('reports a pending apex zone and its redirect host with the assigned nameservers', async () => {
    const checks = await checkPublicationHosts({ website_host: 'moveria.se', media_host: null, media_path_prefix: '', redirect_hosts: ['www.moveria.se'] }, 'automatic',
      [source('hosting', HOSTING, { 'moveria.se': 'pending' })]);
    expect(checks.hosts).toEqual([
      expect.objectContaining({ host: 'moveria.se', role: 'website', kind: 'apex', zone_check: 'found', zone: expect.objectContaining({ status: 'pending', account: 'hosting' }) }),
      expect.objectContaining({ host: 'www.moveria.se', role: 'redirect', kind: 'subdomain' }),
    ]);
    expect(checks.blockers.map(item => [item.code, item.host])).toEqual([['zone_not_active', 'moveria.se'], ['zone_not_active', 'www.moveria.se']]);
    expect(checks.blockers[0].message).toContain('ada.ns.cloudflare.com');
    expect(checks.blockers[0].zone).toEqual({ name: 'moveria.se', status: 'pending', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
    expect(() => assertHostChecks(checks)).toThrow(expect.objectContaining({ code: 'zone_not_active', status: 409 }));
  });

  it('blocks an apex with external DNS when the domain is not a zone in the hosting account', async () => {
    const checks = await checkPublicationHosts({ website_host: 'example.com', media_host: null, media_path_prefix: '' }, 'external', [source('hosting', HOSTING, {})]);
    expect(checks.blockers).toEqual([expect.objectContaining({ code: 'apex_zone_required', severity: 'blocking', host: 'example.com' })]);
    expect(checks.blockers[0].message).toContain('www.example.com');
  });

  it('requires the apex zone in the hosting account, not only in the organization DNS account', async () => {
    const checks = await checkPublicationHosts({ website_host: 'example.com', media_host: null, media_path_prefix: '' }, 'automatic',
      [source('hosting', HOSTING, {}), source('organization', ORGANIZATION, { 'example.com': 'active' })]);
    expect(checks.blockers.map(item => item.code)).toEqual(['apex_zone_in_other_account']);
  });

  it('accepts an active apex zone with a first-level redirect host and rejects deeper ones', async () => {
    const hosts = (redirect_hosts: string[]) => ({ website_host: 'example.com', media_host: null, media_path_prefix: '', redirect_hosts });
    const ok = await checkPublicationHosts(hosts(['www.example.com']), 'automatic', [source('hosting', HOSTING, { 'example.com': 'active' })]);
    expect(ok).toMatchObject({ blockers: [], warnings: [] });
    const deep = await checkPublicationHosts(hosts(['www.shop.example.com']), 'automatic', [source('hosting', HOSTING, { 'example.com': 'active' })]);
    expect(deep.blockers.map(item => item.code)).toEqual(['redirect_host_certificate_unavailable']);
    const external = await checkPublicationHosts(hosts(['www.shop.example.com']), 'external', [source('hosting', HOSTING, { 'example.com': 'active' })]);
    expect(external).toMatchObject({ blockers: [], warnings: [expect.objectContaining({ code: 'redirect_host_certificate_unavailable' })] });
  });

  it('allows an external subdomain without a zone and asks for the redirect at the other provider', async () => {
    const checks = await checkPublicationHosts({ website_host: 'www.example.org', media_host: null, media_path_prefix: '', redirect_hosts: ['example.org'] }, 'external', [source('hosting', HOSTING, {})]);
    expect(checks.blockers).toEqual([]);
    expect(checks.warnings).toEqual([expect.objectContaining({ code: 'redirect_outside_cloudflare', host: 'example.org' })]);
    const automatic = await checkPublicationHosts({ website_host: 'www.example.org', media_host: null, media_path_prefix: '' }, 'automatic', [source('hosting', HOSTING, {})]);
    expect(automatic.blockers.map(item => item.code)).toEqual(['domain_zone_required']);
  });

  it('never turns an unreadable zone list into a blocker', async () => {
    const failing: ZoneSource = { account: 'hosting', accountId: HOSTING, provider: vi.fn(async () => { throw new Error('HTTP 403'); }) };
    const checks = await checkPublicationHosts({ website_host: 'example.com', media_host: null, media_path_prefix: '' }, 'external', [failing]);
    expect(checks.blockers).toEqual([]);
    expect(checks.warnings).toEqual([expect.objectContaining({ code: 'zone_check_unavailable' })]);
    expect(checks.hosts[0]).toMatchObject({ kind: 'apex', zone_check: 'unavailable' });
  });
});

describe('redirect host settings', () => {
  it('normalizes, sorts and de-duplicates a list or comma separated input', () => {
    expect(parsePublicationHosts({ website_host: 'moveria.se', redirect_hosts: 'WWW.moveria.se, www.moveria.se old.moveria.se' }))
      .toEqual({ website_host: 'moveria.se', media_host: null, media_path_prefix: '', redirect_hosts: ['old.moveria.se', 'www.moveria.se'] });
    expect(parsePublicationHosts({ website_host: 'moveria.se', redirect_hosts: [] })).toEqual({ website_host: 'moveria.se', media_host: null, media_path_prefix: '' });
  });
  it('rejects redirect hosts that serve content, have no target or are URLs', () => {
    expect(() => parsePublicationHosts({ website_host: 'moveria.se', redirect_hosts: ['moveria.se'] })).toThrow(expect.objectContaining({ code: 'redirect_host_conflict' }));
    expect(() => parsePublicationHosts({ website_host: 'moveria.se', media_host: 'media.moveria.se', redirect_hosts: ['media.moveria.se'] })).toThrow(expect.objectContaining({ code: 'redirect_host_conflict' }));
    expect(() => parsePublicationHosts({ redirect_hosts: ['www.moveria.se'] })).toThrow(expect.objectContaining({ code: 'website_host_required' }));
    expect(() => parsePublicationHosts({ website_host: 'moveria.se', redirect_hosts: ['https://www.moveria.se/'] })).toThrow(expect.objectContaining({ code: 'invalid_hostname' }));
    expect(() => parsePublicationHosts({ website_host: 'moveria.se', redirect_hosts: ['a.se', 'b.se', 'c.se', 'd.se', 'e.se'] })).toThrow(expect.objectContaining({ code: 'too_many_redirect_hosts' }));
  });
});

describe('site domain API checks', () => {
  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
    const { getStore } = await import('../../lib/datastore');
    const { connectionPath } = await import('../../lib/publishing/connections');
    await getStore().setDoc(paths.site('org', 'site'), { publishing_mode: 'customer_git', name: 'Synthetic site' });
    await getStore().setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'cf', cloudflare: { account_id: HOSTING, bucket: '' } });
    await getStore().setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { job_id: null, lease_id: null, lease_until: 0, last_publication: { snapshot_job_id: 'old', content_cutoff: '2026-10-01T00:00:00Z' } });
    mocks.cloudflare.mockImplementation(zoneProvider(HOSTING, { 'moveria.se': 'pending' }));
  });

  it('returns structured blockers with the saved settings and refuses preparation before any build', async () => {
    const { getSiteDomains, saveSiteDomains } = await import('../../lib/publishing/domain-config');
    const { siteDomainsWithChecks } = await import('../../lib/publishing/host-checks');
    const { prepareDomainTransition } = await import('../../lib/publishing/domain-transition');
    const { getStore } = await import('../../lib/datastore');
    const initial = await getSiteDomains('org', 'site');
    const saved = await saveSiteDomains('org', 'site', { revision: initial.revision, website_host: 'moveria.se', redirect_hosts: ['www.moveria.se'], dns_mode: 'automatic' });
    const response = await siteDomainsWithChecks('org', 'site', saved);
    expect(response.desired).toEqual({ website_host: 'moveria.se', media_host: null, media_path_prefix: '', redirect_hosts: ['www.moveria.se'] });
    expect(response.host_checks?.blockers.map(item => item.code)).toEqual(['zone_not_active', 'zone_not_active']);
    await expect(prepareDomainTransition('org', 'site', { revision: saved.revision })).rejects.toMatchObject({ code: 'zone_not_active', details: { blockers: expect.any(Array) } });
    expect(await getStore().listDocs(paths.deploys('org', 'site'))).toEqual([]);
    expect(mocks.cloudflare.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('keeps settings readable when Cloudflare is unavailable', async () => {
    const { getSiteDomains, saveSiteDomains } = await import('../../lib/publishing/domain-config');
    const { siteDomainsWithChecks } = await import('../../lib/publishing/host-checks');
    mocks.cloudflare.mockRejectedValue(new Error('unavailable'));
    const initial = await getSiteDomains('org', 'site');
    const saved = await saveSiteDomains('org', 'site', { revision: initial.revision, website_host: 'www.moveria.se', dns_mode: 'external' });
    const response = await siteDomainsWithChecks('org', 'site', saved);
    expect(response.revision).toBe(saved.revision);
    expect(response.host_checks?.blockers).toEqual([]);
  });
});

it('does not describe a main domain candidate as the destination of a test Version', async () => {
  const { siteDomainsWithChecks } = await import('../../lib/publishing/host-checks');
  mocks.cloudflare.mockRejectedValue(new Error('unavailable'));
  const config = {revision:'r',active:{website_host:'old.example.com',media_host:null,media_path_prefix:''},desired:{website_host:'new.example.com',media_host:null,media_path_prefix:''},dns_mode:'external' as const,state:'declared' as const,media_aliases:[]};
  expect((await siteDomainsWithChecks('org','site',config,'design-test')).next_publication).toBeNull();
  expect((await siteDomainsWithChecks('org','site',config,'main')).next_publication).toMatchObject({revision:'r',updates_current_host:true});
});
