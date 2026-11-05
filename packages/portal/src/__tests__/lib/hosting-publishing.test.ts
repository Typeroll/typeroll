// Hosted sites wired into publishing: the mode, site creation, the
// publication job (freeze → build on the organization engine → hand to the
// hosting service → verify once), restore, domains and retirement. The
// hosting service is an in-memory fake behind the SITE_HOSTING contract;
// builds and public probes are mocked like in the customer runner tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { FakeSiteHosting } from '../helpers/fake-site-hosting';
import { executeHostedPublication, hostedSourceCommit, HOSTED_VERIFICATION_ATTEMPTS, restoreHostedPublication } from '../../lib/publishing/hosting-runner';
import { executeDeployJob } from '../../lib/deploy/queue';
import { newSitePublishingMode, publishingReadiness } from '../../lib/publishing/readiness';
import { publicationTargets } from '../../lib/publishing/publication-targets';
import { hostingSiteRef, retireHostedSite, setSiteHostingRuntime } from '../../lib/publishing/site-hosting';
import { adoptCustomerPublishingForMedia } from '../../lib/publishing/media-policy';
import { createSite, reserveSite } from '../../lib/site-create';
import { activateDomain, getDomainState, pollDomainStatus, removeDomain, requestDomain, setHostedSiteLaunch, DomainServiceError } from '../../lib/site-domain';
import { publicUrlsFor } from '../../lib/site-public-urls';
import { liveBaseFor } from '../../lib/site-urls';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), built: vi.fn(), probe: vi.fn(), source: vi.fn(), engine: vi.fn(), prepare: vi.fn() }));
vi.mock('../../lib/builds/jobs', () => ({ enqueueBuild: mocks.enqueue, completedBuild: mocks.built }));
vi.mock('../../lib/builds/auto-update', async original => ({ ...await original<object>(), prepareEngineForBuild: mocks.prepare }));
vi.mock('../../lib/builds/selection', async original => ({ ...await original<object>(), selectedBuildProvider: async () => 'cloudflare' }));
vi.mock('../../lib/builds/state', async original => ({ ...await original<object>(), readEngineConfiguration: mocks.engine }));
vi.mock('../../lib/deploy/availability', () => ({ probePublication: mocks.probe }));
vi.mock('../../lib/publishing/source-tree', () => ({ publicationSourceTree: mocks.source }));
// Publications freeze theme fonts from Google; tests never reach the network.
vi.mock('../../lib/publishing/theme-font-freeze', () => ({ freezeThemeFonts: async () => null }));
vi.mock('../../lib/publishing/runtime-projection', () => ({ publicationRuntime: async () => ({ forms: [], apps: { apps: {} }, extensions: { installations: [] }, dependencies: [] }) }));

const ORG = 'org', SITE = 'bakery';
const args = (jobId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, siteId: SITE, versionId: 'main', jobId, environment: 'production' as const, ...extra });
const jobPath = (jobId: string) => paths.deploy(ORG, SITE, jobId);
const ENGINE = { status: 'ready', revision: 'engine-1', provider: 'cloudflare', static_verification: true, media_preparation: true, publication_validation: 1 };
const bytes = (text: string) => new TextEncoder().encode(text);

let hosting: FakeSiteHosting;
/** What the build engine returns for each publication: the site with its marker. */
const artifacts = new Map<string, Record<string, Uint8Array>>();

function hostedEnv(on = true) {
  setSiteHostingRuntime(on ? () => hosting : null);
}
const uid = async () => (await hostingSiteRef(ORG, SITE)).uid;
const liveId = async () => hosting.sites.get(await uid())?.live?.publication_id;

async function seedSite(mode: string = 'hosted', home = '<h1>Fresh bread</h1>') {
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { publishing_mode: mode, name: 'Bakery', media_id: 'abcdefghij', slug: SITE });
  await store.setDoc(paths.version(ORG, SITE, 'main'), { kind: 'main' });
  await store.setDoc(paths.settings(ORG, SITE), { site_name: 'Bakery' });
  await store.setDoc(`${paths.pages(ORG, SITE)}/home`, { title: 'Home', slug: '', content_mode: 'html', html_content: home, status: 'published' });
}

async function queueJob(jobId: string) {
  await getStore().setDoc(jobPath(jobId), { version_id: 'main', status: 'queued', environment: 'production', started_at: new Date().toISOString() });
}

/** Drive one job until it waits for something outside the runner or ends. */
async function run(jobId: string, extra: Record<string, unknown> = {}) {
  for (let step = 0; step < 6; step++) {
    const outcome = await executeHostedPublication(args(jobId, extra));
    if (outcome !== 'continue') return outcome;
  }
  throw new Error('Publication did not yield');
}

/** Publish the current content end to end and return the job. */
async function publish(jobId: string) {
  await queueJob(jobId);
  expect(await run(jobId)).toBe('waiting');
  const job = await getStore().getDoc<any>(jobPath(jobId));
  if (job.status === 'succeeded') return job;
  expect(await run(jobId)).toBe('ran');
  return getStore().getDoc<any>(jobPath(jobId));
}

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  artifacts.clear();
  vi.stubEnv('TYPEROLL_SOURCE_SHA', 'a'.repeat(40));
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  hosting = new FakeSiteHosting();
  mocks.engine.mockResolvedValue(ENGINE);
  mocks.prepare.mockImplementation(async () => ({ state: 'ready', engine: ENGINE }));
  mocks.source.mockImplementation(async (frozen: any) => ({ 'publication.json': JSON.stringify(frozen), 'scripts/build.mjs': 'synthetic source' }));
  mocks.enqueue.mockImplementation(async (_engine: unknown, identity: any) => {
    artifacts.set(`task-${identity.publication_id}`, {
      'index.html': bytes(`<h1>${identity.publication_id}</h1>`), '404.html': bytes('Not found'),
      '.well-known/typeroll/publication.json': bytes(JSON.stringify({ id: identity.publication_id })), '_redirects': bytes('/old / 301\n'),
    });
    return { key: `task-${identity.publication_id}`, task: { status: 'queued' } };
  });
  mocks.built.mockImplementation(async (_org: string, key: string) => ({ task: { seo_report: { passed: true } }, files: artifacts.get(key), direct: null }));
  // The serving host answers with whatever the service serves there.
  mocks.probe.mockImplementation(async (origin: string, _route: string, id: string) => {
    const marker = hosting.served(new URL(origin).hostname)?.['.well-known/typeroll/publication.json'];
    return !!marker && new TextDecoder().decode(marker) === JSON.stringify({ id });
  });
});
afterEach(() => { setSiteHostingRuntime(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('without a hosting service', () => {
  beforeEach(() => hostedEnv(false));

  it('creates customer publishing sites as before and refuses the hosted mode by name', async () => {
    expect(newSitePublishingMode()).toBe('customer_git');
    expect(() => newSitePublishingMode('hosted')).toThrow(expect.objectContaining({ code: 'site_hosting_unavailable', status: 404 }));
    await expect(reserveSite(ORG, 'Hidden', { id: 'hidden', publishingMode: 'hosted' })).rejects.toMatchObject({ code: 'site_hosting_unavailable' });
    expect(await getStore().getDoc(paths.site(ORG, 'hidden'))).toBeNull();
    const { site } = await reserveSite(ORG, 'Plain', { id: 'plain' });
    expect(site.publishing_mode).toBe('customer_git');
    expect(hosting.calls).toEqual([]);
  });

  it('reaches nothing hosted: readiness, the deploy job, domains, restore and retirement are refused', async () => {
    await seedSite();
    const readiness = await publishingReadiness(ORG, SITE, 'main', { checkBuild: false });
    expect(readiness).toMatchObject({ ready: false, mode: 'hosted' });
    expect(readiness.required.map(item => item.code)).toEqual(['site_hosting_unavailable']);

    await queueJob('job');
    expect(await executeDeployJob(args('job'))).toBe('ran');
    expect(await getStore().getDoc(jobPath('job'))).toMatchObject({ status: 'failed', failure: { code: 'site_hosting_unavailable' } });
    expect(mocks.enqueue).not.toHaveBeenCalled();

    await expect(requestDomain(ORG, SITE, 'example.com')).rejects.toMatchObject({ status: 404 });
    await expect(restoreHostedPublication(ORG, SITE)).rejects.toMatchObject({ code: 'site_hosting_unavailable' });
    await expect(retireHostedSite(ORG, SITE)).rejects.toMatchObject({ code: 'site_hosting_unavailable' });
    expect(await publicationTargets(ORG, SITE)).toEqual({ production: false, live_domains: [], targets: [] });
    expect(hosting.calls).toEqual([]);
  });

  it('leaves customer publishing domains with Publishing', async () => {
    await seedSite('customer_git');
    await expect(getDomainState(ORG, SITE)).rejects.toBeInstanceOf(DomainServiceError);
    await expect(removeDomain(ORG, SITE)).rejects.toMatchObject({ status: 409 });
    await expect(requestDomain(ORG, SITE, 'example.com')).rejects.toMatchObject({ status: 503 });
    expect(hosting.calls).toEqual([]);
  });
});

describe('with a bound hosting service', () => {
  beforeEach(() => hostedEnv());

  it('creates a hosted site only when an internal caller asks, with its platform address', async () => {
    const { siteId, site } = await createSite({ orgId: ORG, name: 'Corner Bakery', publishingMode: 'hosted' });
    expect(site).toMatchObject({ publishing_mode: 'hosted', hosting_config: { fallback_subdomain: `${siteId}.example-sites.test` } });
    expect(site.staging_url).toBeUndefined();
    expect(hosting.owners.get(`${siteId}.example-sites.test`)).toBe((await hostingSiteRef(ORG, siteId)).uid);
    expect(publicUrlsFor(site)).toMatchObject({ production: null, fallback: `https://${siteId}.example-sites.test`, staging: null });
    const { site: plain } = await createSite({ orgId: ORG, name: 'Plain' });
    expect(plain.publishing_mode).toBe('customer_git');
  });

  it('needs only the build engine: no GitHub, Hosting Group or website domain', async () => {
    await seedSite();
    const readiness = await publishingReadiness(ORG, SITE, 'main');
    expect(readiness.mode).toBe('hosted');
    expect(readiness.required.map(item => item.code)).toEqual(['build_setup_required']);
    expect((await publishingReadiness(ORG, SITE, 'version-a', { checkBuild: false })).required.map(item => item.code)).toEqual(['hosting_version_unsupported']);
  });

  it('builds on the organization engine without a Pages upload, deploys the artifact and verifies it once', async () => {
    await seedSite();
    await queueJob('job');
    expect(await run('job')).toBe('waiting');
    const building = await getStore().getDoc<any>(jobPath('job'));
    const publication = building.git_publication;
    expect(publication).toMatchObject({ provider: 'hosted', branch: 'main', website_host: `${SITE}.example-sites.test`, build_task_key: `task-${publication.publication_id}` });
    expect(publication.commit).toBe(hostedSourceCommit(publication.publication_id));
    expect(building.execution_backend).toBe('organization_cloudflare');
    expect(mocks.enqueue).toHaveBeenCalledWith(ENGINE, expect.objectContaining({ publication_id: publication.publication_id, commit: publication.commit, branch: 'main' }),
      expect.any(Object), 'publication', expect.objectContaining({ directUpload: false }));

    expect(await run('job')).toBe('ran');
    const job = await getStore().getDoc<any>(jobPath('job'));
    expect(job).toMatchObject({ status: 'succeeded', phase: 'live', deploy_url: `https://${SITE}.example-sites.test`,
      hosted_verification: { host: `${SITE}.example-sites.test`, attempts: 1, ready: true }, seo_report: { passed: true } });
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    const served = hosting.served(`${SITE}.example-sites.test`)!;
    expect(Object.keys(served).sort()).toEqual(['.well-known/typeroll/publication.json', '404.html', '_redirects', 'index.html']);
    expect(await liveId()).toBe(publication.publication_id);
    expect(await getStore().getDoc(paths.version(ORG, SITE, 'main'))).toMatchObject({ deploy_url: `https://${SITE}.example-sites.test`, last_deployed_content_at: publication.content_cutoff });
    expect((await getStore().getDoc<any>(`${paths.site(ORG, SITE)}/publishing_targets/main`)).last_publication.publication_id).toBe(publication.publication_id);
    // Nothing is scheduled to check the site again.
    expect((await getStore().getDoc<any>(jobPath('job'))).continuation?.due_at ?? null).toBeNull();
  });

  it('reports an unchanged publication without building again', async () => {
    await seedSite();
    await publish('first');
    mocks.enqueue.mockClear();
    await queueJob('again');
    expect(await run('again')).toBe('ran');
    expect(await getStore().getDoc(jobPath('again'))).toMatchObject({ status: 'succeeded', phase: 'unchanged' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('restores the previous publication when the new one is never served', async () => {
    await seedSite();
    const first = await publish('first');
    await getStore().updateDoc(`${paths.pages(ORG, SITE)}/home`, { html_content: '<h1>New loaves</h1>' });
    await queueJob('second');
    expect(await run('second')).toBe('waiting');
    mocks.probe.mockResolvedValue(false);
    let outcome = await run('second');
    for (let attempt = 1; attempt < HOSTED_VERIFICATION_ATTEMPTS; attempt++) {
      expect(outcome).toBe('waiting');
      expect((await getStore().getDoc<any>(jobPath('second'))).hosted_verification.attempts).toBe(attempt);
      outcome = await run('second');
    }
    expect(outcome).toBe('ran');
    const failed = await getStore().getDoc<any>(jobPath('second'));
    expect(failed).toMatchObject({ status: 'failed', failure: { code: 'hosted_verification_failed' } });
    expect(failed.error).toContain('The previous publication was restored.');
    expect(await liveId()).toBe(first.git_publication.publication_id);
  });

  it('rolls back to an earlier publication through activate, recorded as a deploy', async () => {
    await seedSite();
    const first = await publish('first');
    await getStore().updateDoc(`${paths.pages(ORG, SITE)}/home`, { html_content: '<h1>New loaves</h1>' });
    const second = await publish('second');
    expect(second.status).toBe('succeeded');
    const restored = await restoreHostedPublication(ORG, SITE, { actor: 'user-1' });
    expect(restored).toMatchObject({ publication_id: first.git_publication.publication_id, replaced_publication_id: second.git_publication.publication_id, verified: true, uploaded_files: 0 });
    expect(await getStore().getDoc(jobPath(restored.job_id))).toMatchObject({ status: 'succeeded', source: 'hosted_restore', hosted_verification: { ready: true } });
    expect(await getStore().getDoc(paths.version(ORG, SITE, 'main'))).toMatchObject({ last_deployed_content_at: first.git_publication.content_cutoff });
    // A publication in progress holds the lease: a restore waits for it.
    await getStore().updateDoc(`${paths.site(ORG, SITE)}/publishing_targets/main`, { job_id: 'running', lease_until: Date.now() + 60_000 });
    await expect(restoreHostedPublication(ORG, SITE)).rejects.toMatchObject({ code: 'publication_in_progress' });
  });

  it('refuses version and staging publications', async () => {
    await seedSite();
    await queueJob('job');
    expect(await executeHostedPublication(args('job', { environment: 'staging' }))).toBe('ran');
    expect(await getStore().getDoc(jobPath('job'))).toMatchObject({ status: 'failed', failure: { code: 'hosting_version_unsupported' } });
  });

  it('runs a hosted site through the deploy queue dispatch', async () => {
    await seedSite();
    await queueJob('job');
    expect(await executeDeployJob(args('job'))).toBe('continue');
    expect((await getStore().getDoc<any>(jobPath('job'))).git_publication.provider).toBe('hosted');
  });

  it('manages custom domains through the existing domain verbs, launching on activation', async () => {
    await seedSite();
    await publish('first');
    const added = await requestDomain(ORG, SITE, 'www.example.com', { prefer: 'apex' });
    expect(added).toMatchObject({ hostname: 'example.com', status: 'pending', dns_target: 'customers.example-sites.test', alias: { hostname: 'www.example.com', status: 'pending' }, canonical_kind: 'apex' });
    expect(hosting.sites.get(await uid())!.domains.custom.map(domain => domain.hostname).sort()).toEqual(['example.com', 'www.example.com']);
    // The declared domain is the canonical host of the next publication (domain-first).
    expect(await requestDomain(ORG, SITE, 'example.com')).toMatchObject({ hostname: 'example.com' });
    await expect(activateDomain(ORG, SITE)).rejects.toMatchObject({ status: 412 });

    hosting.activateHostname('example.com'); hosting.activateHostname('www.example.com');
    expect(await pollDomainStatus(ORG, SITE)).toMatchObject({ status: 'verified', alias: { status: 'verified' } });
    expect(await activateDomain(ORG, SITE)).toMatchObject({ status: 'live', alias: { status: 'live' } });
    expect(await getDomainState(ORG, SITE)).toMatchObject({ status: 'live' });
    expect(hosting.sites.get(await uid())!.domains).toMatchObject({ launched: true, primary_host: 'example.com' });

    const site = { ...(await getStore().getDoc<any>(paths.site(ORG, SITE))), id: SITE };
    expect(publicUrlsFor(site).production).toBe('https://example.com');
    expect(liveBaseFor(site, { id: 'main', kind: 'main', last_deployed_at: new Date().toISOString() } as any)).toBe('https://example.com');
    expect(await publicationTargets(ORG, SITE)).toEqual({ production: true, live_domains: ['https://example.com'], targets: ['https://example.com', `https://${SITE}.example-sites.test`] });

    // The next publication is built for the custom domain and verified there.
    await getStore().updateDoc(`${paths.pages(ORG, SITE)}/home`, { html_content: '<h1>On our own domain</h1>' });
    const job = await publish('second');
    expect(job).toMatchObject({ status: 'succeeded', deploy_url: 'https://example.com', git_publication: { website_host: 'example.com' } });

    await removeDomain(ORG, SITE);
    expect(hosting.owners.has('example.com')).toBe(false);
    expect(hosting.sites.get(await uid())!.domains).toMatchObject({ launched: false, primary_host: null, custom: [] });
    expect(await getStore().getDoc(paths.site(ORG, SITE))).not.toHaveProperty('domain');
    expect(await publicationTargets(ORG, SITE)).toMatchObject({ production: false, live_domains: [] });
  });

  it('launches on the platform address without a custom domain', async () => {
    await seedSite();
    await publish('first');
    expect(await setHostedSiteLaunch(ORG, SITE, true)).toEqual({ launched: true, primary_host: null });
    expect(hosting.sites.get(await uid())!.domains).toMatchObject({ launched: true, primary_host: null });
    const site = { ...(await getStore().getDoc<any>(paths.site(ORG, SITE))), id: SITE };
    expect(publicUrlsFor(site).production).toBe(`https://${SITE}.example-sites.test`);
    expect(await publicationTargets(ORG, SITE)).toMatchObject({ production: true, live_domains: [`https://${SITE}.example-sites.test`] });
  });

  it('keeps a hosted site hosted when organization media storage is ready', async () => {
    await seedSite();
    expect(await adoptCustomerPublishingForMedia(ORG, SITE)).toBe(false);
    expect((await getStore().getDoc<any>(paths.site(ORG, SITE))).publishing_mode).toBe('hosted');
  });

  it('retires a hosted site through the service', async () => {
    await seedSite();
    await publish('first');
    await requestDomain(ORG, SITE, 'shop.example.com');
    expect(hosting.sites.has(await uid())).toBe(true);
    expect(await retireHostedSite(ORG, SITE)).toEqual({ retired: true });
    expect(hosting.sites.size).toBe(0);
    expect(hosting.owners.size).toBe(0);
    // Idempotent: an interrupted retirement runs again.
    expect(await retireHostedSite(ORG, SITE)).toEqual({ retired: true });
  });
});
