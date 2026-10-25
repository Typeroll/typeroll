import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
  const { markOrganizationMediaHostUsed } = await import('../../lib/publishing/domain-config');
  await markOrganizationMediaHostUsed('org', saved);
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

it('approves redirect hosts only with their prepared rule and certificate, and freezes them with the approval', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { getSiteDomains, saveSiteDomains, approveDomainCutover, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const initial = await getSiteDomains('org', 'site');
  const saved = await saveSiteDomains('org', 'site', { revision: initial.revision, website_host: 'moveria.se', redirect_hosts: ['www.moveria.se'], dns_mode: 'automatic' });
  const candidate = { id: 'publication', revision: saved.revision, commit: 'sha', deployment_id: 'deployment', verified_at: new Date().toISOString() };
  const preparation = { hostname: 'moveria.se', provider_status: 'active', certificate_ready: true, requirements: [], dns_fingerprint: 'apex', action: 'approve_cutover', has_existing_traffic: true };
  const redirect = { hostname: 'www.moveria.se', target_host: 'moveria.se', provider_status: 'redirect', certificate_ready: true, edge_certificate: 'active', requirements: [], dns_fingerprint: 'www', zone_id: 'zone', zone_name: 'moveria.se',
    action: 'approve_cutover', has_existing_traffic: true, blocker: { code: 'redirect_rule_required', message: 'Create a Single Redirect rule' },
    rule: { zone_name: 'moveria.se', phase: 'http_request_dynamic_redirect', ref: 'typeroll_redirect_x', expression: 'http.host eq "www.moveria.se"', target_url_expression: 'x', status_code: 301, preserve_query_string: true, status: 'required', managed: false } };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { candidate, preparation });
  await expect(approveDomainCutover('org', 'site', { revision: saved.revision, candidate_id: 'publication' })).rejects.toMatchObject({ code: 'redirect_preparation_pending' });
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { redirect_preparations: [redirect] });
  await expect(approveDomainCutover('org', 'site', { revision: saved.revision, candidate_id: 'publication' })).rejects.toMatchObject({ code: 'redirect_rule_required' });
  const ready = { ...redirect, blocker: null, rule: { ...redirect.rule, status: 'configured', managed: true } };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { redirect_preparations: [ready] });
  const approved = await approveDomainCutover('org', 'site', { revision: saved.revision, candidate_id: 'publication' });
  expect(approved.approved_redirect_preparations).toEqual([ready]);
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

it('corrects unused organization hosts, including sites with text-only Git publications', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { paths } = await import('@typeroll/shared');
  const { getOrganizationDomains, saveOrganizationDomains, canReplaceOrganizationMediaHost } = await import('../../lib/publishing/domain-config');
  const initial = await getOrganizationDomains('org');
  const saved = await saveOrganizationDomains('org', { revision: initial.revision, default_domain: 'media.example.com', dns_mode: 'external' });
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Text only' });
  const snapshot = JSON.stringify({ site_url: 'https://site.media.example.com', media_manifest: null, media: [] });
  await getStore().setDoc(paths.deploy('org', 'site', 'text'), { git_publication: { snapshot_chunks: 1, snapshot_digest: createHash('sha256').update(snapshot).digest('hex') } });
  await getStore().setDoc(`${paths.deploy('org', 'site', 'text')}/snapshot_chunks/0000`, { data: snapshot });
  expect(await canReplaceOrganizationMediaHost('org', saved)).toBe(true);
  const corrected = await saveOrganizationDomains('org', { revision: saved.revision, media_host: 'media-staging.example.com', sites_domain: 'sites-staging.example.com', dns_mode: 'automatic' });
  expect(corrected).toMatchObject({ media_host: 'media-staging.example.com', sites_domain: 'sites-staging.example.com', verified_at: null });
  await expect(saveOrganizationDomains('org', { revision: saved.revision, media_host: 'stale.example.com', dns_mode: 'external' })).rejects.toMatchObject({ code: 'domain_revision_conflict' });
});

it.each(['media record', 'verified host', 'frozen alias', 'incomplete history'])('protects a saved hostname with %s', async reason => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { paths } = await import('@typeroll/shared');
  const { getOrganizationDomains, saveOrganizationDomains, organizationDomainConfigPath, canReplaceOrganizationMediaHost } = await import('../../lib/publishing/domain-config');
  const store = getStore();
  const initial = await getOrganizationDomains('org');
  await saveOrganizationDomains('org', { revision: initial.revision, media_host: 'old.example.com', dns_mode: 'external' });
  await store.setDoc(paths.site('org', 'site'), { name: 'Site' });
  if (reason === 'media record') await store.setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png' });
  if (reason === 'verified host') await store.updateDoc(organizationDomainConfigPath('org'), { verified_at: '2026-09-08T00:00:00Z' });
  if (reason === 'frozen alias' || reason === 'incomplete history') {
    const snapshot = JSON.stringify({ media_manifest: { media_host: 'images.client.com', entries: [{ aliases: [{ url: 'https://old.example.com/site/image.png' }] }] } });
    await store.setDoc(paths.deploy('org', 'site', 'branch-job'), { version_id: 'other-branch', git_publication: { snapshot_chunks: 1, snapshot_digest: createHash('sha256').update(snapshot).digest('hex') } });
    if (reason === 'frozen alias') await store.setDoc(`${paths.deploy('org', 'site', 'branch-job')}/snapshot_chunks/0000`, { data: snapshot });
  }
  const saved = await getOrganizationDomains('org');
  expect(await canReplaceOrganizationMediaHost('org', saved)).toBe(false);
  await expect(saveOrganizationDomains('org', { revision: saved.revision, media_host: 'new.example.com', dns_mode: 'external' })).rejects.toMatchObject({ code: 'domain_migration_required' });
});

it('rejects replacement when publishing reserves the old host during the empty-media scan', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { getOrganizationDomains, saveOrganizationDomains, markOrganizationMediaHostUsed, organizationDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const store = getStore();
  const initial = await getOrganizationDomains('org');
  const saved = await saveOrganizationDomains('org', { revision: initial.revision, media_host: 'old.example.com', dns_mode: 'external' });
  const compare = store.compareAndUpdateDoc.bind(store);
  const spy = vi.spyOn(store, 'compareAndUpdateDoc').mockImplementation(async (path, predicate, patch) => {
    if (path === organizationDomainConfigPath('org') && patch.media_host === 'new.example.com') await markOrganizationMediaHostUsed('org', saved);
    return compare(path, predicate, patch);
  });
  try {
    await expect(saveOrganizationDomains('org', { revision: saved.revision, media_host: 'new.example.com', dns_mode: 'external' })).rejects.toMatchObject({ code: 'domain_revision_conflict' });
    expect((await getOrganizationDomains('org')).media_host).toBe('old.example.com');
  } finally { spy.mockRestore(); }
});

it('rejects a stale publication reservation after an unused hostname was replaced', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getOrganizationDomains, saveOrganizationDomains, markOrganizationMediaHostUsed } = await import('../../lib/publishing/domain-config');
  const initial = await getOrganizationDomains('org');
  const saved = await saveOrganizationDomains('org', { revision: initial.revision, media_host: 'old.example.com', dns_mode: 'external' });
  await saveOrganizationDomains('org', { revision: saved.revision, media_host: 'new.example.com', dns_mode: 'external' });
  await expect(markOrganizationMediaHostUsed('org', saved)).rejects.toMatchObject({ code: 'domain_revision_conflict' });
});

it('retains a verified candidate when redirect hosts change, but revokes the old traffic approval', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { getSiteDomains, saveSiteDomains, domainPublicationRevision, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const initial = await getSiteDomains('org', 'site');
  const saved = await saveSiteDomains('org', 'site', { revision: initial.revision, website_host: 'example.com', dns_mode: 'automatic' });
  const candidate = { id: 'publication', revision: saved.revision, commit: 'sha', deployment_id: 'deployment', verified_at: new Date().toISOString(), job_id: 'job' };
  const preparation = { hostname: 'example.com', provider_status: 'active', certificate_ready: true, requirements: [], dns_fingerprint: 'before', action: 'approve_cutover', has_existing_traffic: true };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { candidate, preparation, state: 'ready_to_switch', cutover_approved_revision: saved.revision, approved_preparation: preparation });
  const added = await saveSiteDomains('org', 'site', { revision: saved.revision, website_host: 'example.com', redirect_hosts: ['www.example.com'], dns_mode: 'automatic' });
  expect(added.revision).not.toBe(saved.revision);
  expect(domainPublicationRevision(added)).toBe(saved.revision);
  expect(added).toMatchObject({ candidate, preparation, state: 'preparing', approved_preparation: null, cutover_approved_revision: null, redirect_preparations: null });
  const removed = await saveSiteDomains('org', 'site', { revision: added.revision, website_host: 'example.com', dns_mode: 'automatic' });
  expect(removed.candidate).toEqual(candidate);
  expect(domainPublicationRevision(removed)).toBe(saved.revision);
  const unchanged = await saveSiteDomains('org', 'site', { revision: removed.revision, website_host: 'example.com', dns_mode: 'automatic' });
  expect(unchanged).toEqual(removed);
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { state: 'distributing' });
  await expect(saveSiteDomains('org', 'site', { revision: removed.revision, website_host: 'example.com', redirect_hosts: ['www.example.com'], dns_mode: 'automatic' })).rejects.toMatchObject({ code: 'domain_cutover_in_progress' });
});

it('refreshes redirect requirements on an existing candidate without queuing a new publication', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { paths } = await import('@typeroll/shared');
  const { getSiteDomains, saveSiteDomains, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const { prepareDomainTransition } = await import('../../lib/publishing/domain-transition');
  const store = getStore();
  await store.setDoc(paths.site('org', 'site'), { name: 'Site', publishing_mode: 'customer_git' });
  await store.setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { last_publication: { snapshot_job_id: 'old' } });
  const initial = await getSiteDomains('org', 'site');
  const saved = await saveSiteDomains('org', 'site', { revision: initial.revision, website_host: 'example.com', redirect_hosts: ['www.example.com'], dns_mode: 'external' });
  const candidate = { id: 'publication', revision: saved.revision, commit: 'sha', deployment_id: 'deployment', verified_at: new Date().toISOString(), job_id: 'job' };
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { state: 'ready_to_switch', candidate,
    preparation: { hostname: 'example.com', provider_status: 'active', certificate_ready: true, requirements: [], dns_fingerprint: 'before', action: 'approve_cutover', has_existing_traffic: true } });
  await store.setDoc(paths.deploy('org', 'site', 'job'), { status: 'running', version_id: 'main', phase: 'awaiting domain cutover approval', git_publication: { publication_id: 'publication' } });
  const removed = await saveSiteDomains('org', 'site', { revision: saved.revision, website_host: 'example.com', dns_mode: 'external' });
  expect(await prepareDomainTransition('org', 'site', { revision: removed.revision })).toEqual({ job_id: 'job', already_running: false, reused_candidate: true, candidate_id: 'publication' });
  expect((await store.listDocs(paths.deploys('org', 'site'))).map(job => job.id)).toEqual(['job']);
  expect(await getSiteDomains('org', 'site')).toMatchObject({ state: 'ready_to_switch', candidate });
});

it('requires explicit confirmation before replacing a verified content candidate', async () => {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { getSiteDomains, saveSiteDomains, siteDomainConfigPath } = await import('../../lib/publishing/domain-config');
  const { domainChangeImpact } = await import('../../lib/publishing/domain-impact');
  const initial = await getSiteDomains('org', 'site');
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { state: 'ready_to_switch', candidate: { id: 'verified', revision: initial.revision }, desired: { website_host: 'old.example.com', media_host: null, media_path_prefix: '' } });
  const input = { revision: initial.revision, website_host: 'new.example.com', media_host: null, dns_mode: 'automatic' };
  expect(await domainChangeImpact('org', 'site', input)).toMatchObject({ confirmation_required: true, estimate_seconds: null });
  await expect(saveSiteDomains('org', 'site', input)).rejects.toMatchObject({ code: 'domain_rebuild_confirmation_required' });
  expect((await getSiteDomains('org', 'site')).candidate?.id).toBe('verified');
  expect(await saveSiteDomains('org', 'site', { ...input, confirm_rebuild: true })).toMatchObject({ state: 'declared', candidate: null });
});
