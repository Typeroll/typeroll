import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { domainPublicationRevision, getSiteDomains, saveSiteDomains, siteDomainConfigPath, approveDomainCutover, type DomainConfiguration } from '../../lib/publishing/domain-config';
import { saveSnapshot } from '../../lib/publishing/publication-snapshot';
import { generatedCloudflareNames } from '../../lib/publishing/cloudflare-account-claims';

const mocks = vi.hoisted(() => ({ provider: vi.fn(), ready: vi.fn(), launch: vi.fn(), settings: {} as Record<string, unknown>, enqueue: vi.fn(), sitesDomain: null as string | null }));
vi.mock('node:dns/promises', () => ({ Resolver: class { async resolveNs() { return ['ns1.example.net', 'ns2.example.net']; } } }));
vi.mock('../../lib/publishing/host-checks', async original => ({ ...await original<object>(),
  siteZoneSources: async () => [{ account: 'hosting', accountId: 'account', provider: mocks.provider }],
  siteHostChecks: async () => ({ hosts: [], blockers: [], warnings: [] }), assertHostChecks: () => undefined }));
vi.mock('../../lib/publishing/readiness', () => ({ publishingReadiness: mocks.ready, assertPublishingReady: async () => undefined }));
vi.mock('../../lib/publishing/publication-version', () => ({ resolvePublicationVersion: async () => ({ redirects: [], settings: mocks.settings }) }));
vi.mock('../../lib/publishing/cloudflare-capabilities', () => ({ cloudflarePermissionReport: async () => ({ capabilities: [] }) }));
vi.mock('../../lib/migration-launch-report', () => ({ buildMigrationLaunchReport: mocks.launch }));
vi.mock('../../lib/deploy/queue', () => ({ getDeployQueue: () => ({ enqueue: mocks.enqueue }) }));
vi.mock('../../lib/publishing/hosting-groups', async original => ({ ...await original<object>(),
  siteHostingGroup: async () => ({ id: 'default', name: 'Default', revision: 'r', sites_domain: mocks.sitesDomain, dns_mode: 'automatic' }) }));

import { readDomainGuide } from '../../lib/publishing/domain-guide';
import { prepareDomainTransition } from '../../lib/publishing/domain-transition';
import { headHasNoindex, launchRobotsFindings, stripRobotsNoindex } from '../../lib/publishing/launch-robots';
import { vstore } from '../../lib/version-store';

const targetPath = () => `${paths.site('org', 'site')}/publishing_targets/main`;

/** Store a real frozen snapshot as the last main publication. */
async function publish(frozen: Record<string, unknown>, id = 'pub') {
  const reference = await saveSnapshot({ orgId: 'org', siteId: 'site', jobId: `${id}-job` }, frozen);
  await getStore().setDoc(targetPath(), { last_publication: { publication_id: id, snapshot_job_id: `${id}-job`, ...reference } });
}

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  mocks.settings = {}; mocks.sitesDomain = null;
  mocks.ready.mockResolvedValue({ ready: true, required: [] });
  mocks.launch.mockResolvedValue({ launch_ready: true, issues: [] });
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.provider.mockImplementation(async route => route.startsWith('/zones?') ? [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' }, name_servers: ['ns1.example.net', 'ns2.example.net'] }] : [{ certificate_status: 'active', hosts: ['example.com', '*.example.com'] }]);
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Site', publishing_mode: 'customer_git' });
  const config = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: config.revision, website_host: 'example.com', dns_mode: 'automatic' });
});
afterEach(() => vi.restoreAllMocks());

describe('headHasNoindex', () => {
  it('finds robots noindex meta tags in either attribute order and ignores others', () => {
    expect(headHasNoindex('<meta name="robots" content="noindex, nofollow">')).toBe(true);
    expect(headHasNoindex("<meta content='noindex' name='googlebot'>")).toBe(true);
    expect(headHasNoindex('<meta name="robots" content="index,follow"><meta name="description" content="noindex is a word">')).toBe(false);
    expect(headHasNoindex(undefined)).toBe(false);
  });
});

describe('stripRobotsNoindex', () => {
  it('removes only noindex and nofollow, drops an emptied tag and refuses what it cannot clean', () => {
    expect(stripRobotsNoindex('<meta name="robots" content="noindex, noarchive"><title>x</title>')).toBe('<meta name="robots" content="noarchive"><title>x</title>');
    expect(stripRobotsNoindex('<meta name="robots" content="noindex,nofollow"><link rel="x">')).toBe('<link rel="x">');
    expect(stripRobotsNoindex('<meta name="description" content="noindex">')).toBe('<meta name="description" content="noindex">');
    expect(stripRobotsNoindex('<meta name="robots" content="index" content="noindex">')).toBeNull();
  });
});

describe('domain change check', () => {
  it('blocks a launch whose site settings hide the site, and keeps launch_ready and next_action from advancing', async () => {
    mocks.settings = { sitewide_noindex: true };
    await getStore().setDoc(paths.migrationUrl('org', 'site', 'url'), { source_url: 'https://old.example.com/' });
    await publish({ settings: { sitewide_noindex: true }, authored_noindex: true, robots_blocked: true });
    const guide = await readDomainGuide('org', 'site');
    expect(guide.checks.find(check => check.id === 'candidate_noindex')).toMatchObject({ status: 'action_required', message: expect.stringContaining('allow_noindex_launch') });
    expect(guide.checks.find(check => check.id === 'launch_ready')).toMatchObject({ status: 'action_required' });
    expect(guide).toMatchObject({ can_prepare: false, next_action: 'resolve_noindex' });
  });

  it('blocks when the last publication was frozen with authored noindex although settings changed since', async () => {
    await publish({ settings: { sitewide_noindex: true }, authored_noindex: true, robots_blocked: true });
    const check = (await readDomainGuide('org', 'site')).checks.find(item => item.id === 'candidate_noindex');
    expect(check?.details).toMatchObject({ findings: [expect.objectContaining({ source: 'publication' })] });
  });

  it('reports sitewide_nofollow and a robots meta tag in scripts_head', async () => {
    mocks.settings = { sitewide_nofollow: true, scripts_head: '<meta name="robots" content="noindex">' };
    const check = (await readDomainGuide('org', 'site')).checks.find(item => item.id === 'candidate_noindex');
    expect(check?.message).toMatch(/sitewide_nofollow, a robots noindex meta tag in scripts_head/);
  });

  it('ignores the platform block of the temporary address and leaves an indexable site unaffected', async () => {
    await getStore().setDoc(paths.migrationUrl('org', 'site', 'url'), { source_url: 'https://old.example.com/' });
    await publish({ settings: { sitewide_noindex: true }, authored_noindex: false, robots_blocked: true });
    const guide = await readDomainGuide('org', 'site');
    expect(guide.checks.some(check => check.id === 'candidate_noindex')).toBe(false);
    expect(guide.checks.find(check => check.id === 'launch_ready')).toMatchObject({ status: 'ready' });
    expect(guide).toMatchObject({ can_prepare: true, next_action: 'prepare' });
  });

  it('has nothing to report while the website host is the generated temporary address', async () => {
    mocks.sitesDomain = 'sites.example.net';
    const config = await getSiteDomains('org', 'site');
    const temporary = { ...config, desired: { ...config.desired, website_host: `${generatedCloudflareNames('org', 'site').site_label}.sites.example.net` } } as DomainConfiguration;
    expect(await launchRobotsFindings('org', 'site', temporary, { settings: { sitewide_noindex: true } })).toEqual([]);
  });
});

describe('prepare', () => {
  it('rejects an authored noindex launch unless explicitly allowed', async () => {
    mocks.settings = { sitewide_noindex: true };
    await publish({ settings: { sitewide_noindex: true }, authored_noindex: true, robots_blocked: true });
    const { revision } = await getSiteDomains('org', 'site');
    await expect(prepareDomainTransition('org', 'site', { revision })).rejects.toMatchObject({ status: 409, code: 'candidate_noindex' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await expect(prepareDomainTransition('org', 'site', { revision, allow_noindex_launch: true })).resolves.toMatchObject({ already_running: false });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('turns noindex off and flags the build when confirm_disable_noindex is passed', async () => {
    const write = vi.spyOn(vstore, 'writeSettings').mockResolvedValue(undefined);
    vi.spyOn(vstore, 'settings').mockResolvedValue({ sitewide_noindex: true, sitewide_nofollow: true, scripts_head: '<meta name="robots" content="noindex">' } as never);
    mocks.settings = { sitewide_noindex: true };
    await publish({ settings: { sitewide_noindex: true }, authored_noindex: true, robots_blocked: true });
    const { revision } = await getSiteDomains('org', 'site');
    const result = await prepareDomainTransition('org', 'site', { revision, confirm_disable_noindex: true });
    expect(result).toMatchObject({ already_running: false, noindex_disabled: true });
    expect(write).toHaveBeenCalledWith('org', 'site', 'main', { sitewide_noindex: false, sitewide_nofollow: false, scripts_head: '' });
    expect(await getStore().getDoc(paths.deploy('org', 'site', result.job_id!))).toMatchObject({ publication_intent: 'domain_prepare', clear_authored_noindex: true });
    // While that build runs, the check no longer reports the publication it replaces.
    mocks.settings = {};
    expect((await readDomainGuide('org', 'site')).checks.some(check => check.id === 'candidate_noindex')).toBe(false);
  });

  it('refuses confirm_disable_noindex when scripts_head cannot be cleaned precisely', async () => {
    mocks.settings = { scripts_head: '<meta name="robots" content="index" content="noindex">' };
    await publish({ settings: {}, authored_noindex: false, robots_blocked: true });
    const { revision } = await getSiteDomains('org', 'site');
    await expect(prepareDomainTransition('org', 'site', { revision, confirm_disable_noindex: true })).rejects.toMatchObject({ code: 'candidate_noindex_head' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('keeps a deliberate hidden launch on the job so the check stops blocking', async () => {
    mocks.settings = { sitewide_noindex: true };
    await publish({ settings: { sitewide_noindex: true }, authored_noindex: true, robots_blocked: true });
    const { revision } = await getSiteDomains('org', 'site');
    const result = await prepareDomainTransition('org', 'site', { revision, allow_noindex_launch: true });
    expect(await getStore().getDoc(paths.deploy('org', 'site', result.job_id!))).toMatchObject({ allow_noindex_launch: true });
    const guide = await readDomainGuide('org', 'site');
    expect(guide.checks.find(check => check.id === 'candidate_noindex')).toMatchObject({ status: 'ready' });
    expect(guide.next_action).not.toBe('resolve_noindex');
  });

  it('prepares an indexable site as before', async () => {
    await publish({ settings: { sitewide_noindex: true }, authored_noindex: false, robots_blocked: true });
    const { revision } = await getSiteDomains('org', 'site');
    await expect(prepareDomainTransition('org', 'site', { revision })).resolves.toMatchObject({ already_running: false });
  });
});

describe('approve', () => {
  async function readyCandidate(candidate: Record<string, unknown>) {
    const config = await getSiteDomains('org', 'site');
    await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { state: 'ready_to_switch',
      candidate: { id: 'cand', revision: domainPublicationRevision(config), job_id: 'cand-job', deployment_id: 'd', commit: 'c', verified_at: 'now', ...candidate },
      published: { hosts: config.desired, dns_mode: 'automatic', publication_id: 'cand' } });
    await getStore().setDoc(targetPath(), { last_publication: { publication_id: 'cand' } });
    await getStore().setDoc(paths.deploy('org', 'site', 'cand-job'), { status: 'running', git_publication: { publication_id: 'cand' } });
    return getSiteDomains('org', 'site');
  }

  it('rejects a candidate frozen with authored noindex unless explicitly allowed', async () => {
    const config = await readyCandidate({ sitewide_noindex: true, robots_blocked: false });
    await expect(approveDomainCutover('org', 'site', { revision: config.revision, candidate_id: 'cand' })).rejects.toMatchObject({ code: 'candidate_noindex' });
    // With the override the noindex guard passes; this fixture then stops at the next safety check.
    await expect(approveDomainCutover('org', 'site', { revision: config.revision, candidate_id: 'cand', allow_noindex_launch: true })).rejects.toMatchObject({ code: 'domain_certificate_pending' });
  });

  it('rejects while current settings would hide later publications', async () => {
    mocks.settings = { sitewide_noindex: true };
    const config = await readyCandidate({ sitewide_noindex: false, robots_blocked: false });
    await expect(approveDomainCutover('org', 'site', { revision: config.revision, candidate_id: 'cand' })).rejects.toMatchObject({ code: 'candidate_noindex' });
  });

  it('does not let confirm_disable_noindex bypass approval, but honours a hidden launch chosen at preparation', async () => {
    const config = await readyCandidate({ sitewide_noindex: true, robots_blocked: false });
    await expect(approveDomainCutover('org', 'site', { revision: config.revision, candidate_id: 'cand', confirm_disable_noindex: true })).rejects.toMatchObject({ code: 'candidate_noindex' });
    await getStore().updateDoc(paths.deploy('org', 'site', 'cand-job'), { publication_intent: 'domain_prepare', allow_noindex_launch: true });
    await expect(approveDomainCutover('org', 'site', { revision: config.revision, candidate_id: 'cand' })).rejects.toMatchObject({ code: 'domain_certificate_pending' });
  });

  it('does not change approval of an indexable candidate', async () => {
    const config = await readyCandidate({ sitewide_noindex: false, robots_blocked: false });
    await expect(approveDomainCutover('org', 'site', { revision: config.revision, candidate_id: 'cand' })).rejects.toMatchObject({ code: 'domain_certificate_pending' });
  });
});
