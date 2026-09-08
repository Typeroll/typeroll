import { describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { publicationHostname, publicMediaPath, parsePublicationHosts } from '../../lib/publishing/domain-config';

describe('publication host and path input', () => {
  it('normalizes public names without accepting URLs, credentials or private targets', () => {
    expect(publicationHostname('WWW.Example.COM')).toBe('www.example.com');
    expect(publicationHostname('bilder.räksmörgås.se')).toBe('bilder.xn--rksmrgs-5wao1o.se');
    for (const value of ['https://example.com', 'example.com/x', 'a@b.com', '127.0.0.1', '[::1]', 'foo.local', '*.example.com', 'example.com ', '-foo.com', 'foo..com']) {
      expect(() => publicationHostname(value), value).toThrow();
    }
  });
  it('preserves legacy paths and rejects traversal and reserved assets', () => {
    expect(publicMediaPath('/wp-content/uploads/2023/04/Original.JPG')).toBe('/wp-content/uploads/2023/04/Original.JPG');
    for (const value of ['//other.com/a', '/../a', '/a/./b', '/a/%2e%2e/b', '/a/%252e%252e/b', '/a%5cb', '/_worker.js', '/.well-known/token', '/a?x=1', '/a#x']) {
      expect(() => publicMediaPath(value), value).toThrow();
    }
  });
  it('separates website and media hosts and reserves a prefix on a shared host', () => {
    expect(parsePublicationHosts({ website_host: 'www.example.com', media_host: 'www.example.com' })).toEqual({ website_host: 'www.example.com', media_host: 'www.example.com', media_path_prefix: '/media' });
    expect(parsePublicationHosts({ website_host: 'www.example.com', media_host: 'images.example.com' }).media_path_prefix).toBe('');
    expect(() => parsePublicationHosts({ website_host: 'www.example.com', media_host: 'www.example.com', media_path_prefix: '' })).toThrow('prefix');
  });
});

it('saves future origins without changing live origins, aliases or published content', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { getSiteDomains, saveSiteDomains, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const store = getStore();
  const initial = await getSiteDomains('org', 'site');
  const active = { website_host: 'old.example.com', media_host: 'media.demos.example.com', media_path_prefix: '/site-123' };
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { active, media_aliases: [active], state: 'live', candidate: { id: 'stale' } });
  const saved = await saveSiteDomains('org', 'site', { revision: initial.revision, website_host: 'www.client.com', media_host: 'media.client.com', dns_mode: 'external' });
  expect(saved.desired).toEqual({ website_host: 'www.client.com', media_host: 'media.client.com', media_path_prefix: '' });
  expect(saved.active).toEqual(active);
  expect(saved.media_aliases).toEqual([active]);
  expect(saved.state).toBe('declared');
  expect(saved.candidate).toBeNull();
  await expect(saveSiteDomains('org', 'site', { revision: initial.revision, website_host: 'racing.example.com', dns_mode: 'external' })).rejects.toThrow('changed');
  expect((await getSiteDomains('org', 'site')).desired.website_host).toBe('www.client.com');
  expect((await getSiteDomains('other-org', 'site')).desired.website_host).toBeNull();
});

it('protects the organization default domain from an overwrite that would break existing media', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getOrganizationDomains, saveOrganizationDomains } = await import('../../lib/publishing/domain-config');
  const initial = await getOrganizationDomains('org');
  const saved = await saveOrganizationDomains('org', { revision: initial.revision, default_domain: 'demos.example.com', dns_mode: 'external' });
  expect(saved.verified_at).toBeNull();
  await expect(saveOrganizationDomains('org', { revision: saved.revision, default_domain: 'other.example.com', dns_mode: 'external' })).rejects.toThrow('remain available');
  await expect(saveOrganizationDomains('org', { revision: saved.revision, default_domain: null, dns_mode: 'external' })).rejects.toThrow('remain available');
});

it('requires a matching verified candidate and certificate before approving existing traffic', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { getSiteDomains, approveDomainCutover, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const initial = await getSiteDomains('org', 'site');
  const candidate = { id: 'publication', revision: initial.revision, commit: 'sha', deployment_id: 'deployment', verified_at: new Date().toISOString() };
  const preparation = { hostname: 'www.example.com', provider_status: 'pending', certificate_ready: false, requirements: [], dns_fingerprint: 'fingerprint', action: 'complete_validation', has_existing_traffic: true };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { candidate, preparation });
  await expect(approveDomainCutover('org', 'site', { revision: initial.revision, candidate_id: 'stale' })).rejects.toThrow('changed');
  await expect(approveDomainCutover('org', 'site', { revision: initial.revision, candidate_id: 'publication' })).rejects.toThrow('certificate');
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { preparation: { ...preparation, certificate_ready: true } });
  const approved = await approveDomainCutover('org', 'site', { revision: initial.revision, candidate_id: 'publication' });
  expect(approved.cutover_approved_revision).toBe(initial.revision);
  expect(approved.approved_preparation?.dns_fingerprint).toBe('fingerprint');
  expect(approved.active).toBeNull();
});

it('separates organization site addresses from shared media and preserves legacy configurations', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { getOrganizationDomains, saveOrganizationDomains, organizationDomainConfigPath } = await import('../../lib/publishing/domain-config');
  await getStore().setDoc(organizationDomainConfigPath('org'), { revision: 'legacy', default_domain: 'media.example.com', dns_mode: 'external', verified_at: null });
  expect(await getOrganizationDomains('org')).toMatchObject({ sites_domain: 'media.example.com', media_host: 'media.example.com' });
  const saved = await saveOrganizationDomains('org', { revision: 'legacy', sites_domain: 'sites.example.com', media_host: 'media.example.com', dns_mode: 'external' });
  expect(saved).toMatchObject({ sites_domain: 'sites.example.com', media_host: 'media.example.com' });
  const next = await saveOrganizationDomains('org', { revision: saved.revision, sites_domain: 'demos.example.net', dns_mode: 'external' });
  expect(next).toMatchObject({ sites_domain: 'demos.example.net', media_host: 'media.example.com' });
});
