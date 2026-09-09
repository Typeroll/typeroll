import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath } from '../../lib/publishing/connections';
import { getSiteDomains, saveSiteDomains, siteDomainConfigPath } from '../../lib/publishing/domain-config';
import { executeCustomerPublication } from '../../lib/publishing/customer-runner';
import { captureImpact } from '../../lib/publishing/impact';
import { previewPublicationImpact } from '../../lib/publishing/impact-preview';
import { ProviderError } from '../../lib/publishing/providers.mjs';

const mocks = vi.hoisted(() => ({ github: vi.fn(), cloudflare: vi.fn(), push: vi.fn(), probe: vi.fn(), source: vi.fn(), enqueue: vi.fn(), built: vi.fn(), upload: vi.fn(), verify: vi.fn(), deployment: null as any }));
vi.mock('../../lib/publishing/github-connection', () => ({ githubConfiguration: () => ({ appId: '12', privateKey: 'synthetic-only' }) }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => mocks.cloudflare }));
vi.mock('../../lib/publishing/providers.mjs', async importOriginal => ({ ...await importOriginal<object>(), githubInstallationClient: async () => mocks.github, publishTree: mocks.push }));
vi.mock('../../lib/publishing/source-tree', () => ({ publicationSourceTree: mocks.source }));
vi.mock('../../lib/publishing/runtime-projection', () => ({ publicationRuntime: async () => ({ forms: [], apps: { apps: {} }, extensions: { installations: [] }, dependencies: [] }) }));
vi.mock('../../lib/builds/jobs', () => ({ enqueueBuild: mocks.enqueue, completedBuild: mocks.built }));
vi.mock('../../lib/builds/upload', () => ({ uploadStaticBuild: mocks.upload }));
vi.mock('../../lib/builds/publication', async original => ({ ...await original<object>(), saveStaticChecks: async () => 'builds/org/checks/verified.json', verifyStaticBatch: mocks.verify }));
vi.mock('../../lib/deploy/availability', () => ({ probePublication: mocks.probe }));
const prefix = createHash('sha256').update('org\0site').digest('hex').slice(0, 16);
const project = `typeroll-${prefix}`;
const args = { orgId: 'org', siteId: 'site', versionId: 'main', jobId: 'job', environment: 'production' as const };
const jobPath = paths.deploy('org', 'site', 'job');

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  vi.stubEnv('TYPEROLL_SOURCE_SHA', 'a'.repeat(40));
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  const store = getStore();
  await store.setDoc(paths.site('org', 'site'), { publishing_mode: 'customer_git', name: 'Synthetic site', media_id: 'abcdefghij' });
  await store.setDoc(paths.version('org', 'site', 'main'), { kind: 'main' });
  await store.setDoc(paths.settings('org', 'site'), { site_name: 'Synthetic site' });
  await store.setDoc(`${paths.pages('org', 'site')}/home`, { title: 'Home', slug: '', content_mode: 'html', html_content: '<h1>Frozen first version</h1>', status: 'published' });
  await store.setDoc(connectionPath('org', 'github'), { status: 'connected', revision: 'git', github: { owner: 'Synthetic', account_id: '123', installation_id: '456' } });
  await store.setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'cf', cloudflare: { account_id: 'a'.repeat(32), bucket: '' } });
  const domains = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: domains.revision, website_host: 'www.example.com', dns_mode: 'automatic' });
  await store.setDoc(jobPath, { version_id: 'main', status: 'queued', environment: 'production', started_at: new Date().toISOString() });
  mocks.source.mockImplementation(async frozen => ({ 'publication.json': JSON.stringify(frozen), 'scripts/build.mjs': 'synthetic source' }));
  mocks.push.mockResolvedValue({ commit: 'b'.repeat(40), changed: true });
  mocks.probe.mockResolvedValue(false);
  mocks.deployment = null;
  mocks.github.mockImplementation(async () => ({ private: true, owner: { id: 123 }, id: 789, default_branch: 'main', description: `Generated Typeroll site ${prefix}` }));
  mocks.cloudflare.mockImplementation(async (route: string, options?: any) => {
    if (route.includes('/deployments?')) return mocks.deployment ? [mocks.deployment] : [];
    if (route.includes('/domains/')) return { status: 'active' };
    if (route.startsWith('/zones?')) return [{ id: 'zone', name: 'www.example.com', status: 'active', account: { id: 'a'.repeat(32) } }];
    if (route.includes('/dns_records')) return options?.method ? {} : [{ id: 'dns', name: 'www.example.com', type: 'CNAME', content: `${project}.pages.dev`, proxied: true }];
    return { source: { type: 'github', config: { owner: 'Synthetic', repo_name: project, repo_id: '789' } }, production_branch: 'main', build_config: { build_command: 'npm ci && npm run build' } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function complete(branch = 'main') {
  mocks.deployment = { id: 'deployment', project_name: project, url: `https://immutable.${project}.pages.dev`, environment: branch === 'main' ? 'production' : 'preview', deployment_trigger: { metadata: { commit_hash: 'b'.repeat(40), branch } }, latest_stage: { name: 'deploy', status: 'success' }, uses_functions: false };
}

it('freezes once, waits for the exact Git commit, and hides the live link until public verification', async () => {
  expect(await executeCustomerPublication(args)).toBe('deferred');
  const first = await getStore().getDoc<any>(jobPath);
  expect(first.status).toBe('running');
  expect(first.deploy_url).toBeUndefined();
  expect(first.git_publication.commit).toBe('b'.repeat(40));
  expect(mocks.push).toHaveBeenCalledTimes(1);
  await getStore().updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: '<h1>Later edit</h1>' });
  complete();
  mocks.probe.mockImplementation(async origin => origin.includes('.pages.dev'));
  expect(await executeCustomerPublication(args)).toBe('deferred');
  expect((await getStore().getDoc<any>(jobPath)).deploy_url).toBeUndefined();
  expect(mocks.push).toHaveBeenCalledTimes(1);
  const frozen = JSON.parse(mocks.push.mock.calls[0][1].files['publication.json']);
  expect(frozen.pages[0].html_content).toContain('Frozen first version');
  expect(JSON.stringify(frozen)).not.toContain('Later edit');
  mocks.probe.mockResolvedValue(true);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', deploy_url: 'https://www.example.com' });
  expect(await getStore().getDoc<any>(paths.site('org', 'site'))).toMatchObject({ domain_status: 'live', domain: 'www.example.com' });
  expect(mocks.cloudflare.mock.calls.filter(([route]) => route.endsWith('/purge_cache'))).toHaveLength(1);
  // The later save must be compared with the frozen, verified source, not
  // whatever happened to be in the CMS when the build finally completed.
  expect(await previewPublicationImpact('org', 'site', 'main')).toMatchObject({ comparison: 'verified_snapshot', provisional: true, total: 1, changed_pages: 1, classification: 'page_content_only' });
});

it('reports removal and excludes new drafts using the last verified source', async () => {
  await executeCustomerPublication(args); complete(); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  const store = getStore();
  await store.updateDoc(`${paths.pages('org', 'site')}/home`, { status: 'draft' });
  await store.setDoc(`${paths.pages('org', 'site')}/unpublished`, { title: 'Draft only', slug: 'draft-only', status: 'draft', content_mode: 'html', html_content: '<p>Not public</p>' });
  const impact = await previewPublicationImpact('org', 'site', 'main');
  expect(impact).toMatchObject({ total: 1, removed_pages: 1, changes: [{ id: 'home', action: 'removed', will_deploy: true }] });
  await store.updateDoc(`${paths.pages('org', 'site')}/home`, { status: 'published', date_updated: '2026-09-09T12:00:00.000Z' });
  expect(await previewPublicationImpact('org', 'site', 'main')).toMatchObject({ total: 0, metadata_only: 1 });
});

it('does not treat a failed candidate as the verified comparison baseline', async () => {
  await executeCustomerPublication(args);
  const store = getStore(), job = await store.getDoc<any>(jobPath);
  await store.setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { last_publication: job.git_publication });
  await store.updateDoc(jobPath, { status: 'failed' });
  expect(await previewPublicationImpact('org', 'site', 'main')).toMatchObject({ comparison: 'baseline_unavailable' });
});

it('keeps the public link hidden until this deployment has refreshed its own hostname cache', async () => {
  await executeCustomerPublication(args); complete(); mocks.probe.mockResolvedValue(true);
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route.endsWith('/purge_cache')) throw new ProviderError('Cloudflare', 429);
    return provider(route, options);
  });
  expect(await executeCustomerPublication(args)).toBe('deferred');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ phase: 'waiting for Cloudflare cache refresh' });
  expect((await getStore().getDoc<any>(jobPath)).deploy_url).toBeUndefined();
  mocks.cloudflare.mockImplementation(provider);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', git_publication: { cache_purged_deployment: 'deployment' } });
  expect(mocks.cloudflare).toHaveBeenCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { hosts: ['www.example.com'] } });
});

it('never accepts a successful deployment of another commit or a failed customer build', async () => {
  await executeCustomerPublication(args); complete();
  mocks.deployment.deployment_trigger.metadata.commit_hash = 'c'.repeat(40);
  expect(await executeCustomerPublication(args)).toBe('deferred');
  expect(mocks.probe).not.toHaveBeenCalled();
  mocks.deployment.deployment_trigger.metadata.commit_hash = 'b'.repeat(40);
  mocks.deployment.latest_stage.status = 'failure';
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', error: expect.stringContaining('Cloudflare build failed') });
});

it('reports the failing provider, stage and safe error codes without provider payloads', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await executeCustomerPublication(args);
  mocks.cloudflare.mockRejectedValue(new ProviderError('Cloudflare', 403, [10000]));
  await executeCustomerPublication(args);
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed',
    error: expect.stringContaining('Cloudflare returned HTTP 403 (code 10000)'),
    failure: { stage: 'building on Cloudflare', code: 'provider_request_failed', provider: 'Cloudflare', http_status: 403, provider_codes: [10000] } });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('customer_publication_failed'));
});

it('does not treat main plus staging as authorization to publish the live branch', async () => {
  expect(await executeCustomerPublication({ ...args, environment: 'staging' })).toBe('ran');
  expect(mocks.push).not.toHaveBeenCalled();
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', error: expect.stringContaining('Select a site version') });
});

it('prepares a future domain on a separate branch while the current website remains active', async () => {
  const active = { website_host: 'old.example.com', media_host: null, media_path_prefix: '' };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { active });
  await executeCustomerPublication(args);
  const candidateBranch = mocks.push.mock.calls[0][1].branch;
  expect(candidateBranch).toMatch(/^version-domain-/);
  complete(candidateBranch); mocks.probe.mockResolvedValue(true);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect((await getSiteDomains('org', 'site')).active).toEqual(active);
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ phase: 'awaiting domain cutover approval' });
  await getStore().updateDoc(jobPath, { started_at: '2020-01-01T00:00:00Z' });
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'awaiting domain cutover approval' });
  expect(mocks.cloudflare.mock.calls.some(([, options]) => options?.method === 'PATCH' && options?.body?.type === 'CNAME')).toBe(false);
});

it('resolves the selected version without writing main and handles provider retries without another Git push', async () => {
  await getStore().setDoc(paths.version('org', 'site', 'design'), { kind: 'branch', base_version_id: 'main' });
  await getStore().setDoc(`${paths.pages('org', 'site', 'design')}/home`, { title: 'Design', slug: '', content_mode: 'html', html_content: '<h1>Design version</h1>', status: 'published' });
  const { getOrganizationDomains, saveOrganizationDomains } = await import('../../lib/publishing/domain-config');
  const organization = await getOrganizationDomains('org');
  await saveOrganizationDomains('org', { revision: organization.revision, sites_domain: 'sites.example.com', media_host: 'media.example.net', dns_mode: 'external' });
  const branchArgs = { ...args, versionId: 'design' };
  expect(await executeCustomerPublication(branchArgs)).toBe('deferred');
  const request = mocks.push.mock.calls[0][1];
  expect(request.branch).toBe('version-design');
  expect((await getStore().getDoc<any>(jobPath)).git_publication.website_host).toMatch(/\.sites\.example\.com$/);
  expect((await getStore().getDoc<any>(jobPath)).git_publication.website_host).not.toContain('media.example.net');
  const frozen = JSON.parse(request.files['publication.json']);
  expect(frozen.pages[0].html_content).toContain('Design version');
  expect(frozen.settings.sitewide_noindex).toBe(true);
  expect(await executeCustomerPublication(branchArgs)).toBe('deferred');
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect((await getStore().getDoc<any>(paths.version('org', 'site', 'main'))).last_deployed_at).toBeUndefined();
  await getStore().updateDoc(jobPath, { version_id: 'design' });
  complete('version-design'); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(branchArgs);
  expect(await previewPublicationImpact('org', 'site', 'design')).toMatchObject({ comparison: 'verified_snapshot', total: 0 });
  await getStore().updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: '<p>Main change hidden by branch override</p>' });
  expect(await previewPublicationImpact('org', 'site', 'design')).toMatchObject({ total: 0 });
  await getStore().setDoc(paths.partial('org', 'site', 'header', 'main'), { name: 'header', kind: 'header', content_mode: 'html', html_content: '<nav>Inherited</nav>', status: 'published' });
  expect(await previewPublicationImpact('org', 'site', 'design')).toMatchObject({ total: 1, classification: 'site_wide', changes: [{ kind: 'partial', id: 'header' }] });
});

it('a domain-only preparation reuses the public snapshot and does not publish later saved content', async () => {
  await getStore().updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: '<h1>Public</h1><a href="https://www.example.com/about?from=home#team">About</a>', canonical_url: 'https://www.example.com/' });
  await executeCustomerPublication(args); complete(); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  const previous = (await getStore().getDoc<any>(`${paths.site('org', 'site')}/publishing_targets/main`)).last_publication;
  expect(previous.snapshot_job_id).toBe('job');
  await getStore().updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: '<h1>Unpublished edit</h1>' });
  const domains = await getSiteDomains('org', 'site');
  const next = await saveSiteDomains('org', 'site', { revision: domains.revision, website_host: 'new.example.com', dns_mode: 'external' });
  const nextArgs = { ...args, jobId: 'domain-job' };
  await getStore().setDoc(paths.deploy('org', 'site', nextArgs.jobId), { status: 'queued', publication_intent: 'domain_prepare', domain_revision: next.revision, source_publication: previous });
  mocks.deployment = null;
  expect(await executeCustomerPublication(nextArgs)).toBe('deferred');
  const source = JSON.parse(mocks.push.mock.calls.at(-1)![1].files['publication.json']);
  expect(source.pages[0].html_content).toContain('https://new.example.com/about?from=home#team');
  expect(source.pages[0].canonical_url).toBe('https://new.example.com/');
  expect(JSON.stringify(source)).not.toContain('Unpublished edit');
  expect((await getStore().getDoc<any>(paths.site('org', 'site'))).domain).toBe('www.example.com');
});


it('terminates expired provider observation instead of leaving a job running after queue exhaustion', async () => {
  await getStore().updateDoc(jobPath, { started_at: new Date(Date.now() - 46 * 60_000).toISOString() });
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(mocks.push).not.toHaveBeenCalled();
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'publication_observation_timeout' } });
});

it('publishes ordinary edits to main when datastore map ordering changes but hosts do not', async () => {
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), {
    active: { media_path_prefix: '', media_host: null, website_host: 'www.example.com' },
  });
  await executeCustomerPublication(args);
  expect(mocks.push.mock.calls[0][1].branch).toBe('main');
  expect((await getStore().getDoc<any>(jobPath)).git_publication.release_branch).toBeUndefined();
});

it('clears preview identity under Firestore nested-merge semantics before promoting frozen source', async () => {
  const store = getStore();
  const update = store.updateDoc.bind(store);
  vi.spyOn(store, 'updateDoc').mockImplementation(async (path, patch) => {
    if (path === jobPath && patch.git_publication) {
      const previous = await store.getDoc<any>(path);
      patch = { ...patch, git_publication: { ...previous?.git_publication, ...patch.git_publication } };
    }
    await update(path, patch);
  });
  await update(siteDomainConfigPath('org', 'site'), { active: { website_host: 'old.example.com', media_host: null, media_path_prefix: '' } });
  await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  const domains = await getSiteDomains('org', 'site');
  await update(siteDomainConfigPath('org', 'site'), { cutover_approved_revision: domains.revision, approved_preparation: domains.preparation });
  await executeCustomerPublication(args);
  expect((await store.getDoc<any>(jobPath)).git_publication).toMatchObject({ branch: 'main', commit: null, deployment_id: null, release_branch: null });
  await executeCustomerPublication(args);
  expect(mocks.push).toHaveBeenCalledTimes(2);
  expect(mocks.push.mock.calls[1][1].branch).toBe('main');
  expect(mocks.push.mock.calls[1][1].files).toEqual(mocks.push.mock.calls[0][1].files);
});

it('freezes the Hosting Group and hosting account independently from the organization connection', async () => {
  const { saveHostingGroup } = await import('../../lib/publishing/hosting-groups');
  const group = await saveHostingGroup('org', { name: 'Second account', sites_domain: 'sites2.example.com', dns_mode: 'automatic' });
  await getStore().updateDoc(paths.site('org', 'site'), { hosting_group_id: group.id });
  await getStore().setDoc(connectionPath('org', 'cloudflare', group.id), { status: 'connected', revision: 'group-cf', cloudflare: { account_id: 'e'.repeat(32), bucket: '' } });
  await executeCustomerPublication(args);
  const job = await getStore().getDoc<any>(jobPath);
  expect(job.git_publication).toMatchObject({ hosting_group_id: group.id, hosting_group_revision: group.revision, account_id: 'e'.repeat(32), commit: 'b'.repeat(40) });
  expect(mocks.cloudflare.mock.calls.some(([route]) => route.startsWith('/accounts/' + 'e'.repeat(32) + '/pages/'))).toBe(true);
  await getStore().updateDoc(paths.site('org', 'site'), { hosting_group_id: 'default' });
  mocks.push.mockClear();
  await executeCustomerPublication(args);
  expect(mocks.push).not.toHaveBeenCalled();
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', error: expect.stringContaining('settings changed') });
});

it.each([400, 403, 429, 503])('preserves Cloudflare project creation diagnostics for HTTP %s without misclassifying every failure as Git access', async status => {
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route.endsWith(`/pages/projects/${project}`) && !options?.method) return null;
    if (route.endsWith('/pages/projects') && options?.method === 'POST') throw new ProviderError('Cloudflare', status, [8000001]);
    return provider(route, options);
  });
  await executeCustomerPublication(args);
  const failed = await getStore().getDoc<any>(jobPath);
  expect(failed).toMatchObject({ status: 'failed', failure: {
    provider: 'Cloudflare', http_status: status, provider_codes: [8000001],
    hosting_group_id: 'default', hosting_account_id: 'a'.repeat(32), project,
  } });
  expect(failed.error).toContain(`HTTP ${status}`);
  expect(failed.error).toContain('8000001');
  if (status === 400) expect(failed.error).toContain('Connect to Git');
  else expect(failed.error).not.toContain('Connect to Git');
  if (status === 403) expect(failed.error).toContain('Pages Edit');
  if (status === 429) expect(failed.error).toContain('rate limit');
  expect(failed.deploy_url).toBeUndefined();
  expect(mocks.push).not.toHaveBeenCalled();
});

it('identifies missing Git installation in an extra hosting account without asking to reconnect organization OAuth', async () => {
  const { saveHostingGroup } = await import('../../lib/publishing/hosting-groups');
  const group = await saveHostingGroup('org', { name: 'Second account', sites_domain: 'sites2.example.com', dns_mode: 'automatic' });
  await getStore().updateDoc(paths.site('org', 'site'), { hosting_group_id: group.id });
  await getStore().setDoc(connectionPath('org', 'cloudflare', group.id), { status: 'connected', revision: 'group-cf', cloudflare: { account_id: 'e'.repeat(32), bucket: '' } });
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route.endsWith(`/pages/projects/${project}`) && !options?.method) return null;
    if (route.endsWith('/pages/projects') && options?.method === 'POST') throw new ProviderError('Cloudflare', 401, [8000011]);
    return provider(route, options);
  });
  await executeCustomerPublication(args);
  const failed = await getStore().getDoc<any>(jobPath);
  expect(failed).toMatchObject({ status: 'failed', failure: { hosting_group_id: group.id, hosting_account_id: 'e'.repeat(32), http_status: 401, provider_codes: [8000011] } });
  expect(failed.error).toContain('Git installation is missing');
  expect(failed.error).toContain('Connect to Git');
  expect(failed.error).not.toContain('renew authorization');
  expect(failed.deploy_url).toBeUndefined();
});

it.each(['cloudflare', 'github'] as const)('uses the %s engine and blocks the live link until actual static files are verified', async providerName => {
  await getStore().setDoc('organizations/org/publishing/build_selection', { provider: providerName, revision: 'selection' });
  await getStore().setDoc(`organizations/org/publishing_private/${providerName === 'github' ? 'github_build_engine' : 'build_engine'}`, { status: 'ready', provider: providerName, revision: 'engine-1', account_id: 'a'.repeat(32) });
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route === `/accounts/${'a'.repeat(32)}/pages/projects/${project}`) return { name: project, production_branch: 'main' };
    return provider(route, options);
  });
  mocks.enqueue.mockResolvedValue({ key: 'task' }); mocks.built.mockResolvedValue(null);
  expect(await executeCustomerPublication(args)).toBe('deferred');
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ revision: 'engine-1' }), expect.objectContaining({ org_id: 'org', site_id: 'site', version_id: 'main', branch: 'main', commit: 'b'.repeat(40) }), expect.any(Object));
  expect(mocks.upload).not.toHaveBeenCalled();
  await getStore().updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: 'New unsaved-to-Git version' });
  await getStore().updateDoc('organizations/org/publishing/build_selection', { provider: providerName === 'github' ? 'cloudflare' : 'github' });
  mocks.built.mockResolvedValue({ files: { 'index.html': Buffer.from('frozen') } });
  complete(); const finished = mocks.deployment;
  // Disabled Pages Git integrations still emit a skipped deployment for this commit.
  mocks.deployment = { ...finished, id: 'skipped-git-build', is_skipped: true, latest_stage: { name: 'queued', status: 'idle' } };
  mocks.upload.mockImplementation(async () => { mocks.deployment = finished; return finished; });
  mocks.probe.mockResolvedValue(true); mocks.verify.mockResolvedValue(false);
  expect(await executeCustomerPublication(args)).toBe('deferred');
  expect(mocks.upload).toHaveBeenCalledWith(mocks.cloudflare, expect.objectContaining({ account: 'a'.repeat(32), group: 'default', branch: 'main' }), { 'index.html': Buffer.from('frozen') });
  expect((await getStore().getDoc<any>(jobPath)).deploy_url).toBeUndefined();
  mocks.verify.mockResolvedValue(true);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', execution_backend: providerName === 'github' ? 'organization_github' : 'organization_cloudflare' });
  expect(mocks.push).toHaveBeenCalledTimes(1); expect(mocks.enqueue).toHaveBeenCalledTimes(1); expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.push.mock.calls[0][1].files['publication.json']).not.toContain('New unsaved');
});
it('does not fall back to per-site Git builds when shared engine setup is unfinished', async () => {
  await getStore().setDoc('organizations/org/publishing_private/build_engine', { status: 'qualifying', revision: 'engine-1' });
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', error: expect.stringContaining('Finish shared build setup') });
  expect(mocks.push).not.toHaveBeenCalled();
});

it('keeps the candidate and existing traffic when the provider cannot prevalidate the domain', async () => {
  const active = { website_host: 'old.example.com', media_host: null, media_path_prefix: '' };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { active });
  await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route.includes('/domains/')) return { status: 'pending', validation_data: { method: 'http' }, verification_data: { error_message: 'CNAME record not set' } };
    if (route.includes('/dns_records')) return [{ id: 'existing', type: 'A', content: '192.0.2.10' }];
    return provider(route, options);
  });
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'domain_prevalidation_unavailable' }, error: expect.stringContaining('Keep the existing DNS records') });
  expect(await getSiteDomains('org', 'site')).toMatchObject({ active, candidate: { commit: 'b'.repeat(40) }, preparation: { validation_blocker: { code: 'domain_prevalidation_unavailable' } } });
  expect(mocks.cloudflare.mock.calls.some(([, options]) => options?.method === 'PATCH' && options?.body?.type === 'CNAME')).toBe(false);
});

it('explains the observed verification failure when the observation window expires', async () => {
  await getStore().updateDoc(jobPath, { started_at: '2020-01-01T00:00:00Z', verification_message: 'The hosting service still returns HTTP 200 at /gone/; this deployment requires HTTP 404. Public verification will retry automatically.' });
  await executeCustomerPublication(args);
  const job = await getStore().getDoc<any>(jobPath);
  expect(job.error).toContain('HTTP 200 at /gone/');
  expect(job.error).not.toContain('retry automatically');
  expect(job.verification_message).toBe(job.error);
  expect(job.status).toBe('failed');
  expect(job.deploy_url).toBeUndefined();
});

it('captures media impact from the same records used in the frozen media manifest', async () => {
  const store = getStore();
  await store.updateDoc(connectionPath('org', 'cloudflare'), { media_ready: true, encrypted_credentials: 'synthetic-reference', cloudflare: { account_id: 'a'.repeat(32), bucket: 'originals', public_bucket: 'public' } });
  await store.updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: '<img src="https://media.example.com/photo.png">' });
  const media = { id: 'photo', filename: 'photo.png', mime_type: 'image/png', cdn_url: 'https://media.example.com/photo.png', sha256: 'c'.repeat(64), size_bytes: 12, storage: { provider: 'organization_r2', state: 'ready', account_id: 'a'.repeat(32), bucket: 'originals', key: 'photo.png' } };
  await store.setDoc(`${paths.media('org', 'site')}/photo`, media);
  const domains = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: domains.revision, website_host: 'www.example.com', media_host: 'media.example.com', dns_mode: 'automatic' });
  const list = vi.spyOn(store, 'listDocs');
  await executeCustomerPublication({ ...args, dryRun: true });
  expect((await store.getDoc<any>(jobPath)).error).toBeFalsy();
  const frozen = mocks.source.mock.calls[0][0];
  const observed = frozen.source_impact_snapshot.entries.find((entry: any) => entry.kind === 'media');
  const expected = captureImpact({ version_id: 'main', pages: [{ id: 'home', html_content: '<img src="https://media.example.com/photo.png">' }] }, 'org', 'site', [media]).entries.find(entry => entry.kind === 'media');
  expect(observed.fields).toEqual(expected?.fields);
  expect(frozen.media_manifest.entries[0].sha256).toBe(media.sha256);
  expect(list.mock.calls.filter(([path]) => path === paths.media('org', 'site'))).toHaveLength(2);
});
