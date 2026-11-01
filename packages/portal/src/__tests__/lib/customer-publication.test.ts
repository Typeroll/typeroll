import { resolvePublicationReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath, ConnectionError } from '../../lib/publishing/connections';
import { getSiteDomains, saveSiteDomains, siteDomainConfigPath } from '../../lib/publishing/domain-config';
import { executeCustomerPublication as executePublicationPhase } from '../../lib/publishing/customer-runner';
import { captureImpact } from '../../lib/publishing/impact';
import { previewPublicationImpact } from '../../lib/publishing/impact-preview';
import { ProviderError } from '../../lib/publishing/providers.mjs';

async function executeCustomerPublication(args: Parameters<typeof executePublicationPhase>[0]) {
  for (let step = 0; step < 4; step++) {
    const outcome = await executePublicationPhase(args);
    if (outcome !== 'continue') return outcome;
  }
  throw new Error('Publication did not yield to its build provider');
}

const mocks = vi.hoisted(() => ({ github: vi.fn(), cloudflare: vi.fn(), push: vi.fn(), probe: vi.fn(), source: vi.fn(), enqueue: vi.fn(), built: vi.fn(), upload: vi.fn(), verify: vi.fn(), candidateVerification: vi.fn(), verificationPlan: vi.fn(), direct: vi.fn(), runtime: { forms: [], apps: { apps: {} }, extensions: { installations: [] }, dependencies: [] } as any, derive: vi.fn(), deployment: null as any }));
vi.mock('../../lib/publishing/github-connection', () => ({ githubConfiguration: () => ({ appId: '12', privateKey: 'synthetic-only' }) }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => mocks.cloudflare }));
vi.mock('../../lib/publishing/providers.mjs', async importOriginal => ({ ...await importOriginal<object>(), githubInstallationClient: async () => mocks.github, publishTree: mocks.push }));
vi.mock('../../lib/publishing/source-tree', () => ({ publicationSourceTree: mocks.source }));
const fonts = vi.hoisted(() => ({ freeze: vi.fn() }));
// Publications freeze theme fonts from Google; tests never reach the network.
vi.mock('../../lib/publishing/theme-font-freeze', () => ({ freezeThemeFonts: fonts.freeze }));
vi.mock('../../lib/publishing/runtime-projection', () => ({ publicationRuntime: async () => mocks.runtime }));
vi.mock('../../lib/extensions/auth', async original => ({ ...await original<object>(), signInstallationAssertion: () => 'synthetic-proof' }));
vi.mock('../../lib/extensions/admin-request', async original => ({ ...await original<object>(), requestApprovedAdmin: mocks.derive }));
vi.mock('../../lib/builds/jobs', () => ({ enqueueBuild: mocks.enqueue, completedBuild: mocks.built }));
vi.mock('../../lib/builds/upload', () => ({ uploadStaticBuild: mocks.upload, finalizeDirectUpload: mocks.direct }));
vi.mock('../../lib/builds/publication', async original => ({ ...await original<object>(), saveStaticChecks: async () => 'builds/org/checks/verified.json', verifyStaticBatch: mocks.verify, verifyCustomerCandidate: mocks.candidateVerification, saveCustomerVerification: mocks.verificationPlan }));
vi.mock('../../lib/deploy/availability', () => ({ probePublication: mocks.probe }));
const resanitize = vi.hoisted(() => vi.fn());
vi.mock('../../lib/media/svg-media', async original => ({ ...await original<object>(), resanitizeStoredSvgMedia: resanitize }));
const redirectProbe = vi.hoisted(() => vi.fn(async () => ({ ok: true, status: 301, location: null as string | null })));
vi.mock('../../lib/publishing/redirect-hosts', async original => ({ ...await original<object>(), verifyRedirectHost: redirectProbe }));
const prefix = createHash('sha256').update('org\0site').digest('hex').slice(0, 16);
const project = `typeroll-${prefix}`;
const args = { orgId: 'org', siteId: 'site', versionId: 'main', jobId: 'job', environment: 'production' as const };
const jobPath = paths.deploy('org', 'site', 'job');

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  fonts.freeze.mockResolvedValue(null);
  mocks.runtime = { forms: [], apps: { apps: {} }, extensions: { installations: [] }, dependencies: [] };
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
  await store.updateDoc(siteDomainConfigPath('org','site'), {active:{website_host:'www.example.com',media_host:null,media_path_prefix:''},active_dns_mode:'automatic'});
  await store.setDoc(jobPath, { version_id: 'main', status: 'queued', environment: 'production', started_at: new Date().toISOString() });
  mocks.source.mockImplementation(async frozen => ({ 'publication.json': JSON.stringify(frozen), 'scripts/build.mjs': 'synthetic source' }));
  mocks.push.mockResolvedValue({ commit: 'b'.repeat(40), changed: true });
  mocks.probe.mockResolvedValue(false);
  mocks.deployment = null;
  mocks.github.mockImplementation(async () => ({ private: true, owner: { id: 123 }, id: 789, default_branch: 'main', description: `Generated Typeroll site ${prefix}` }));
  mocks.cloudflare.mockImplementation(async (route: string, options?: any) => {
    if (route.endsWith('/deployments/deployment')) return mocks.deployment;
    if (route.includes('/deployments?')) return mocks.deployment ? [mocks.deployment] : [];
    if (route.includes('/domains/')) return { status: 'active' };
    if (route.startsWith('/zones?')) return [{ id: 'zone', name: new URL('https://api.invalid'+route).searchParams.get('name'), status: 'active', account: { id: 'a'.repeat(32) } }];
    if (route.includes('/dns_records')) return options?.method ? {} : [{ id: 'dns', name: new URL('https://api.invalid'+route).searchParams.get('name') ?? 'www.example.com', type: 'CNAME', content: `${project}.pages.dev`, proxied: true }];
    return { source: { type: 'github', config: { owner: 'Synthetic', repo_name: project, repo_id: '789' } }, production_branch: 'main', build_config: { build_command: 'npm ci && npm run build' } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function complete(branch = 'main') {
  mocks.deployment = { id: 'deployment', project_name: project, url: `https://immutable.${project}.pages.dev`, environment: branch === 'main' ? 'production' : 'preview', deployment_trigger: { metadata: { commit_hash: 'b'.repeat(40), branch } }, latest_stage: { name: 'deploy', status: 'success' }, uses_functions: false };
}

async function prepareFromCurrentPublication() {
  const baselineArgs = {...args,jobId:'baseline'};
  await getStore().setDoc(paths.deploy('org','site','baseline'),{version_id:'main',status:'queued'});
  await executeCustomerPublication(baselineArgs); complete(); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(baselineArgs);
  const target=await getStore().getDoc<any>(`${paths.site('org','site')}/publishing_targets/main`);
  expect(target.last_publication,JSON.stringify(await getStore().getDoc(paths.deploy('org','site','baseline')))).toBeTruthy();
  await getStore().updateDoc(jobPath,{publication_intent:'domain_prepare',domain_revision:((await getSiteDomains('org','site')).publication_revision ?? (await getSiteDomains('org','site')).revision),source_publication:target.last_publication});
  mocks.push.mockClear(); mocks.cloudflare.mockClear(); mocks.deployment=null; mocks.probe.mockResolvedValue(false);
}

it('freezes once, waits for the exact Git commit, and hides the live link until public verification', async () => {
  expect(await executeCustomerPublication(args)).toBe('waiting');
  const first = await getStore().getDoc<any>(jobPath);
  expect(first.status).toBe('running');
  expect(first.deploy_url).toBeUndefined();
  expect(first.git_publication.commit).toBe('b'.repeat(40));
  expect(mocks.push).toHaveBeenCalledTimes(1);
  await getStore().updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: '<h1>Later edit</h1>' });
  complete();
  mocks.probe.mockImplementation(async origin => origin.includes('.pages.dev'));
  expect(await executeCustomerPublication(args)).toBe('waiting');
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
  expect(await executeCustomerPublication(args)).toBe('waiting');
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
  expect(await executeCustomerPublication(args)).toBe('waiting');
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

it('replaces main with future origins before DNS approval without creating a preview branch', async () => {
  const active = { website_host: 'old.example.com', media_host: null, media_path_prefix: '' };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { active });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  const candidateBranch = mocks.push.mock.calls[0][1].branch;
  expect(candidateBranch).toBe('main');
  complete(candidateBranch); mocks.probe.mockResolvedValue(true);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect((await getSiteDomains('org', 'site')).active).toEqual(active);
  expect((await getSiteDomains('org', 'site')).published).toMatchObject({ hosts: { website_host: 'www.example.com' } });
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
  expect(await executeCustomerPublication(branchArgs)).toBe('waiting');
  const request = mocks.push.mock.calls[0][1];
  expect(request.branch).toBe('version-design');
  expect((await getStore().getDoc<any>(jobPath)).git_publication.website_host).toMatch(/\.sites\.example\.com$/);
  expect((await getStore().getDoc<any>(jobPath)).git_publication.website_host).not.toContain('media.example.net');
  const frozen = JSON.parse(request.files['publication.json']);
  expect(frozen.pages[0].html_content).toContain('Design version');
  expect(frozen.settings.sitewide_noindex).toBe(true);
  expect(await executeCustomerPublication(branchArgs)).toBe('waiting');
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
  vi.stubEnv('TYPEROLL_SOURCE_SHA', 'c'.repeat(40));
  const nextArgs = { ...args, jobId: 'domain-job' };
  await getStore().setDoc(paths.deploy('org', 'site', nextArgs.jobId), { status: 'queued', publication_intent: 'domain_prepare', domain_revision: next.revision, source_publication: previous });
  mocks.deployment = null;
  expect(await executeCustomerPublication(nextArgs)).toBe('waiting');
  const source = resolvePublicationReferences(JSON.parse(mocks.push.mock.calls.at(-1)![1].files['publication.json']));
  expect(source.core_commit).toBe('c'.repeat(40));
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

it('preserves the build failure after long media preparation instead of reporting a verification timeout', async () => {
  const key = 'd'.repeat(64);
  await getStore().updateDoc(jobPath, { started_at: new Date(Date.now() - 70 * 60_000).toISOString(), git_publication: { build_task_key: key } });
  await getStore().setDoc(`organizations/org/build_tasks/${key}`, { status: 'failed', error_code: 'artifact_static_output_size_limit', deadline: Date.now() + 3600000 });
  mocks.built.mockRejectedValueOnce(new ConnectionError('The finished site exceeds the publication limit.', 413, 'artifact_static_output_size_limit'));
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(mocks.built).toHaveBeenCalledWith('org', key);
  expect(mocks.push).not.toHaveBeenCalled();
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'artifact_static_output_size_limit' } });
});

it('keeps the cause a failed build step printed on the failed job', async () => {
  const key = 'd'.repeat(64), diagnostic = { cause: 'Error: Invalid media completion receipt', lines: ['Error: Invalid media completion receipt', '    at prepareEntry (file:///work/scripts/media.mjs:141:120)'] };
  await getStore().updateDoc(jobPath, { git_publication: { build_task_key: key } });
  await getStore().setDoc(`organizations/org/build_tasks/${key}`, { status: 'failed', error_code: 'media_build_process_exit_1', error_detail: diagnostic, deadline: Date.now() + 3600000 });
  mocks.built.mockRejectedValueOnce(new ConnectionError('The build failed while preparing images and files: the step exited with code 1. Cause: Error: Invalid media completion receipt.', 502, 'media_build_process_exit_1', { build_diagnostic: diagnostic }));
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', error: expect.stringContaining('Cause: Error: Invalid media completion receipt.'),
    failure: { code: 'media_build_process_exit_1', diagnostic } });
});

it('publishes ordinary edits to main when datastore map ordering changes but hosts do not', async () => {
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), {
    active: { media_path_prefix: '', media_host: null, website_host: 'www.example.com' },
  });
  await executeCustomerPublication(args);
  expect(mocks.push.mock.calls[0][1].branch).toBe('main');
  expect((await getStore().getDoc<any>(jobPath)).git_publication.release_branch).toBeUndefined();
});

it('rejects legacy preview preparations without promoting or rebuilding them', async () => {
  await executeCustomerPublication(args);
  const store = getStore(), original = await store.getDoc<any>(jobPath);
  await store.updateDoc(jobPath, { git_publication: { ...original.git_publication, release_branch: 'main', branch: 'version-domain-legacy' } });
  mocks.push.mockClear();
  await executeCustomerPublication(args);
  expect(await store.getDoc(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'domain_republication_required' } });
  expect(mocks.push).not.toHaveBeenCalled();
});

it('switches DNS for the same main artifact without a second push, build or upload', async () => {
  const store = getStore();
  await prepareFromCurrentPublication();
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route === `/accounts/${'a'.repeat(32)}/pages/projects/${project}`) return { name: project, production_branch: 'main' };
    return provider(route, options);
  });
  await store.setDoc('organizations/org/publishing_private/build_engine', { status: 'ready', static_verification: true, revision: 'engine-1', account_id: 'a'.repeat(32) });
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { active: { website_host: 'old.example.com', media_host: null, media_path_prefix: '' } });
  mocks.enqueue.mockResolvedValue({ key: 'same-task' }); mocks.built.mockResolvedValue(null);
  mocks.verify.mockResolvedValue(true); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  const frozen = (await store.getDoc<any>(jobPath)).git_publication;
  complete(frozen.branch);
  const preview = mocks.deployment; mocks.deployment = null;
  mocks.built.mockResolvedValue({ task: {}, files: { 'index.html': Buffer.from('verified candidate') } });
  mocks.upload.mockImplementation(async (_client, target) => {
    const deployment = { ...preview, id: target.branch === 'main' ? 'promoted' : 'deployment', environment: target.branch === 'main' ? 'production' : 'preview', deployment_trigger: { metadata: { commit_hash: target.commit, branch: target.branch } } };
    mocks.deployment = deployment; return deployment;
  });
  await executeCustomerPublication(args);
  expect((await store.getDoc<any>(jobPath)).phase).toBe('awaiting domain cutover approval');
  const domains = await getSiteDomains('org', 'site');
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { cutover_approved_revision: domains.revision, approved_preparation: domains.preparation });
  await executeCustomerPublication(args);
  expect((await store.getDoc<any>(jobPath)).git_publication.build_task_key).toBe('same-task');
  mocks.deployment = null;
  await executeCustomerPublication(args);
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect((await store.getDoc<any>(jobPath)).status).toBe('succeeded');
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
  if (status === 429 || status >= 500) {
    expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'running', coordinator_retries: 1 });
    for (let attempt = 0; attempt < 5; attempt++) await executeCustomerPublication(args);
  }
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
  await getStore().setDoc(`organizations/org/publishing_private/${providerName === 'github' ? 'github_build_engine' : 'build_engine'}`, { status: 'ready', static_verification: true, provider: providerName, revision: 'engine-1', account_id: 'a'.repeat(32) });
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route === `/accounts/${'a'.repeat(32)}/pages/projects/${project}`) return { name: project, production_branch: 'main' };
    return provider(route, options);
  });
  mocks.enqueue.mockResolvedValue({ key: 'task' }); mocks.built.mockResolvedValue(null);
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ revision: 'engine-1' }), expect.objectContaining({ org_id: 'org', site_id: 'site', version_id: 'main', branch: 'main', commit: 'b'.repeat(40) }), expect.any(Object));
  expect(mocks.upload).not.toHaveBeenCalled();
  await getStore().updateDoc(jobPath, { started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
  await getStore().setDoc('organizations/org/build_tasks/task', { status: 'queued', deadline: Date.now() + 60_000, media_total: 1001, media_cursor: 750 });
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'preparing media: 750 of 1001 files ready; continuing automatically' });
  expect(mocks.upload).not.toHaveBeenCalled();
  await getStore().updateDoc('organizations/org/build_tasks/task', { status: 'completed', completed_at: Date.now(), media_cursor: 1001 });
  await getStore().updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: 'New unsaved-to-Git version' });
  await getStore().updateDoc('organizations/org/publishing/build_selection', { provider: providerName === 'github' ? 'cloudflare' : 'github' });
  const renderReport = { format: 1, mode: 'partial', rendered: 1, reused: 49, total: 50, removed: 0, reason: 'unchanged_routes_reused' };
  mocks.built.mockResolvedValue({ task: { render_report: renderReport }, files: { 'index.html': Buffer.from('frozen') } });
  complete(); const finished = mocks.deployment;
  // Disabled Pages Git integrations still emit a skipped deployment for this commit.
  mocks.deployment = { ...finished, id: 'skipped-git-build', is_skipped: true, latest_stage: { name: 'queued', status: 'idle' } };
  mocks.upload.mockImplementation(async () => { mocks.deployment = finished; return finished; });
  mocks.probe.mockResolvedValue(true); mocks.verify.mockResolvedValue(false);
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(mocks.upload).toHaveBeenCalledWith(mocks.cloudflare, expect.objectContaining({ account: 'a'.repeat(32), group: 'default', branch: 'main' }), { 'index.html': Buffer.from('frozen') });
  expect((await getStore().getDoc<any>(jobPath)).deploy_url).toBeUndefined();
  expect((await getStore().getDoc<any>(jobPath)).render_report).toEqual(renderReport);
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

it('keeps the candidate and existing traffic when the provider cannot prevalidate several records', async () => {
  const active = { website_host: 'old.example.com', media_host: null, media_path_prefix: '' };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { active });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route.includes('/domains/')) return { status: 'pending', validation_data: { method: 'http' }, verification_data: { error_message: 'CNAME record not set' } };
    if (route.includes('/dns_records')) return [{ id: 'existing', type: 'A', name: 'www.example.com', content: '192.0.2.10' }, { id: 'second', type: 'A', name: 'www.example.com', content: '192.0.2.11' }];
    return provider(route, options);
  });
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'running', phase: 'awaiting domain cutover approval' });
  expect((await getSiteDomains('org', 'site')).state).toBe('preparing');
  expect(await getSiteDomains('org', 'site')).toMatchObject({ active, candidate: { commit: 'b'.repeat(40) }, preparation: { validation_blocker: { code: 'domain_prevalidation_unavailable', resolution: 'external_dns_change' } } });
  expect(mocks.cloudflare.mock.calls.some(([, options]) => options?.method === 'PATCH' && options?.body?.type === 'CNAME')).toBe(false);
  mocks.cloudflare.mockImplementation(provider);
  const {prepareDomainTransition}=await import('../../lib/publishing/domain-transition');
  const beforeRefresh=await getSiteDomains('org','site');
  const pushCount=mocks.push.mock.calls.length;
  expect(await prepareDomainTransition('org','site',{revision:beforeRefresh.revision})).toMatchObject({reused_candidate:true,job_id:args.jobId});
  expect(await getSiteDomains('org','site')).toMatchObject({state:'ready_to_switch',candidate:{id:beforeRefresh.candidate!.id}});
  expect(mocks.push).toHaveBeenCalledTimes(pushCount);

});

it.each(['live', 'timeout', 'manual rollback'])('switches one reviewed record after acceptance and handles %s under the publication lease', async (outcome) => {
  const store = getStore();
  const active = { website_host: 'old.example.com', media_host: null, media_path_prefix: '' };
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { active });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch);
  let validated = false;
  mocks.probe.mockImplementation(async origin => origin.includes('.pages.dev') || origin === 'https://old.example.com' || validated);
  const records: Array<Record<string, unknown>> = [{ id: 'existing', type: 'A', name: 'www.example.com', content: '192.0.2.10', proxied: false }];
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route.includes('/domains/')) return validated ? { status: 'active' } : { status: 'pending', validation_data: { method: 'http' }, verification_data: { error_message: 'CNAME record not set' } };
    if (route === '/zones/zone/dns_records/existing' && ['PATCH', 'PUT'].includes(options?.method)) { records.splice(0, 1, { id: 'existing', ...options.body }); return {}; }
    if (route.includes('/dns_records') && !options?.method) return records;
    return provider(route, options);
  });
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'awaiting domain cutover approval', validation_blocker: { resolution: 'accept_validation_window' } });
  const prepared = await getSiteDomains('org', 'site');
  expect(prepared).toMatchObject({ state: 'ready_to_switch', preparation: { validation_blocker: { code: 'domain_prevalidation_unavailable', message: expect.stringContaining('restore A www.example.com 192.0.2.10 (DNS only)') } } });
  expect(prepared.preparation!.validation_blocker!.message).toContain('15 minutes to 24 hours');
  const { approveDomainCutover } = await import('../../lib/publishing/domain-config');
  await expect(approveDomainCutover('org', 'site', { revision: prepared.revision, candidate_id: prepared.candidate!.id })).rejects.toMatchObject({ code: 'validation_window_acceptance_required' });
  expect(records[0]).toMatchObject({ type: 'A', content: '192.0.2.10' });
  // Approval with acceptance; the queue continuation is exercised by the next runner calls.
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { cutover_approved_revision: prepared.revision, approved_preparation: prepared.preparation, approved_validation_window: true });
  await executeCustomerPublication(args);
  await executeCustomerPublication(args);
  complete('main');
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(records[0]).toMatchObject({ type: 'CNAME', content: `${project}.pages.dev`, proxied: true });
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'waiting for Cloudflare to validate www.example.com after the approved switch',
    verification_message: expect.stringContaining('Previous destination: A www.example.com 192.0.2.10 (DNS only)') });
  if (outcome === 'timeout') {
    await store.updateDoc(`${paths.site('org', 'site')}/domain_cutovers/${prepared.candidate!.id}`, { deadline_at: Date.now() - 1 });
    await executeCustomerPublication(args);
    expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'domain_cutover_timeout' } });
    expect(records[0]).toMatchObject({ type: 'A', content: '192.0.2.10', proxied: false });
    expect(await getSiteDomains('org', 'site')).toMatchObject({ active, rollback_status: 'rolled_back' });
    return;
  }
  validated = true;
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', deploy_url: 'https://www.example.com', verification_message: null });
  if (outcome === 'manual rollback') {
    await store.updateDoc(siteDomainConfigPath('org', 'site'), { rollback_requested: true, state: 'distributing' });
    await store.updateDoc(jobPath, { status: 'running', phase: 'restoring previous domain traffic' });
    await executeCustomerPublication(args);
    expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'failed', phase: 'previous traffic restored' });
    expect(records[0]).toMatchObject({ type: 'A', content: '192.0.2.10', proxied: false });
    expect(await getSiteDomains('org', 'site')).toMatchObject({ active, rollback_status: 'rolled_back' });
  }
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
  await saveSiteDomains('org', 'site', { revision: domains.revision, website_host: 'future.example.com', media_host: 'future-media.example.com', media_path_prefix: '/future', dns_mode: 'automatic' });
  await store.updateDoc(siteDomainConfigPath('org','site'), {active:{website_host:'www.example.com',media_host:'media.example.com',media_path_prefix:''}});
  const list = vi.spyOn(store, 'listDocs');
  await executeCustomerPublication({ ...args, dryRun: true });
  expect((await store.getDoc<any>(jobPath)).error).toBeFalsy();
  const frozen = mocks.source.mock.calls[0][0];
  const observed = frozen.source_impact_snapshot.entries.find((entry: any) => entry.kind === 'media');
  const expected = captureImpact({ version_id: 'main', pages: [{ id: 'home', html_content: '<img src="https://media.example.com/photo.png">' }] }, 'org', 'site', [media]).entries.find(entry => entry.kind === 'media');
  expect(observed.fields).toEqual(expected?.fields);
  expect(frozen.media_manifest.entries[0].sha256).toBe(media.sha256);
  expect(frozen.media_manifest.media_host).toBe('media.example.com');
  expect(frozen.media_manifest.entries[0].cdn_url).not.toContain('/future');
  expect(frozen.site_url).toBe('https://www.example.com');
  expect(list.mock.calls.filter(([path]) => path === paths.media('org', 'site'))).toHaveLength(2);
});


it('stops a dry run on an image link without an accessible name, as the build would', async () => {
  const store = getStore();
  await store.updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: '<p><a href="/partner"><img src="/a.png" alt=""></a></p>' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await executeCustomerPublication({ ...args, dryRun: true });
  const job = await store.getDoc<any>(jobPath);
  expect(job).toMatchObject({ status: 'failed', failure: expect.objectContaining({ code: 'publication_validation_failed' }) });
  expect(job.error).toContain('Image link has no accessible name: /partner');
});

it('freezes the theme fonts into the publication and stops before building when they cannot be copied', async () => {
  const store = getStore();
  const frozenFonts = { css_url: 'https://fonts.googleapis.com/css2?family=Inter', css: '@font-face{}', files: [{ name: `${'a'.repeat(32)}.woff2`, sha256: 'b'.repeat(64), data: 'AA==' }] };
  fonts.freeze.mockResolvedValueOnce(frozenFonts);
  await executeCustomerPublication({ ...args, dryRun: true });
  expect(mocks.source.mock.calls[0][0].theme_fonts).toEqual(frozenFonts);
  const { ConnectionError } = await import('../../lib/publishing/connections');
  fonts.freeze.mockRejectedValueOnce(new ConnectionError('The theme fonts could not be copied', 503, 'theme_fonts_unavailable'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await store.updateDoc(jobPath, { status: 'queued', error: null });
  await executeCustomerPublication({ ...args, dryRun: true });
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'failed', failure: expect.objectContaining({ code: 'theme_fonts_unavailable' }) });
  expect(mocks.source).toHaveBeenCalledTimes(1);
});

it('publishes without an SVG that cannot be made safe and reports it on the job', async () => {
  const store = getStore();
  await store.updateDoc(connectionPath('org', 'cloudflare'), { media_ready: true, encrypted_credentials: 'synthetic-reference', cloudflare: { account_id: 'a'.repeat(32), bucket: 'originals', public_bucket: 'public' } });
  const privateUrl = 'https://cms.example.com/api/sites/site/media/logo/content';
  await store.updateDoc(`${paths.pages('org', 'site')}/home`, { html_content: `<img src="${privateUrl}"><img src="https://media.example.com/photo.png">` });
  const storage = (key: string) => ({ provider: 'organization_r2', state: 'ready', account_id: 'a'.repeat(32), bucket: 'originals', key });
  await store.setDoc(`${paths.media('org', 'site')}/logo`, { filename: 'logo.svg', mime_type: 'image/svg+xml', cdn_url: privateUrl, sha256: 'd'.repeat(64), size_bytes: 12, storage: storage('logo.svg') });
  await store.setDoc(`${paths.media('org', 'site')}/photo`, { filename: 'photo.png', mime_type: 'image/png', cdn_url: 'https://media.example.com/photo.png', sha256: 'c'.repeat(64), size_bytes: 12, storage: storage('photo.png') });
  const domains = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: domains.revision, website_host: 'www.example.com', media_host: 'media.example.com', media_path_prefix: '', dns_mode: 'automatic' });
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { active: { website_host: 'www.example.com', media_host: 'media.example.com', media_path_prefix: '' } });
  resanitize.mockResolvedValue({ scanned: 1, svg: 1, unchanged: 0, sanitized: [], rejected: [{ media_id: 'logo', error: 'Not an SVG document.' }], skipped: [], mode: 'dry-run' });
  await executeCustomerPublication({ ...args, dryRun: true });
  // A dry run never writes media records.
  expect(resanitize).toHaveBeenCalledWith('org', 'site', { apply: false, mediaIds: ['logo'] });
  const job = await store.getDoc<any>(jobPath);
  expect(job).toMatchObject({ status: 'succeeded', dry_run: true });
  expect(job.warnings).toEqual([expect.stringContaining('Media logo (logo.svg) was not published')]);
  const frozen = mocks.source.mock.calls[0][0];
  expect(frozen.media_manifest.entries.map((entry: any) => entry.id)).toEqual(['photo']);
  // The builder resolves the reference to nothing instead of a private address.
  const resolved = resolvePublicationReferences(frozen);
  expect(JSON.stringify(resolved.pages)).not.toContain('/api/sites/site/media/logo/content');
  expect(JSON.stringify(resolved.pages)).toContain('<img src=\\"\\">');
});

it('keeps direct publication waiting for customer verification, then runs only bounded coordinator probes', async () => {
  await getStore().setDoc('organizations/org/publishing_private/build_engine', { status: 'ready', static_verification: true, revision: 'engine-1', account_id: 'a'.repeat(32) });
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => route === `/accounts/${'a'.repeat(32)}/pages/projects/${project}` ? { name: project, production_branch: 'main' } : provider(route, options));
  mocks.enqueue.mockResolvedValue({ key: 'task' }); mocks.built.mockResolvedValue(null);
  expect(await executeCustomerPublication(args)).toBe('waiting');
  await getStore().setDoc('organizations/org/build_tasks/task', { status: 'completed', completed_at: Date.now() });
  mocks.built.mockResolvedValue({ task: {}, files: {}, direct: { format: 1 } });
  mocks.verificationPlan.mockResolvedValue({ verification_checks_key: 'customer-checks', probe_checks_key: 'bounded-probes', static_controls_sha256: 'controls' });
  mocks.direct.mockImplementation(async () => { complete(); return mocks.deployment; });
  mocks.probe.mockResolvedValue(true); mocks.candidateVerification.mockResolvedValue(false);
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'verifying static output on the organization build engine' });
  expect((await getStore().getDoc<any>(jobPath)).deploy_url).toBeUndefined();
  expect(mocks.verify).not.toHaveBeenCalled();
  mocks.candidateVerification.mockResolvedValue(true); mocks.verify.mockResolvedValue(true);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(mocks.verify.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mocks.verify.mock.calls.every(call => call[2] === 'bounded-probes' && call[4] === true)).toBe(true);
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', deploy_url: 'https://www.example.com' });
});

it('requires an engine update before queuing a new shared publication on the legacy supervisor', async () => {
  await getStore().setDoc('organizations/org/publishing_private/build_engine', { status: 'ready', revision: 'old-engine', account_id: 'a'.repeat(32) });
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => route === `/accounts/${'a'.repeat(32)}/pages/projects/${project}` ? { name: project, production_branch: 'main' } : provider(route, options));
  await executeCustomerPublication(args);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(await getStore().getDoc<any>(jobPath)).toMatchObject({ status: 'failed', error: expect.stringContaining('Update the build engine') });
});

it('yields after freezing and Git publication and never recaptures intervening edits', async () => {
  expect(await executePublicationPhase(args)).toBe('continue');
  expect(mocks.push).not.toHaveBeenCalled();
  expect(mocks.github).not.toHaveBeenCalled();
  expect(mocks.cloudflare).not.toHaveBeenCalled();
  const first = await getStore().getDoc<any>(jobPath);
  expect(first).toMatchObject({ phase: 'source frozen', coordinator: { phase: 'source frozen', duration_ms: expect.any(Number) } });
  await getStore().updateDoc(paths.page('org', 'site', 'home'), { html_content: '<h1>Later draft edit</h1>' });
  expect(await executePublicationPhase(args)).toBe('continue');
  const uploaded = mocks.push.mock.calls[0][1].files['publication.json'];
  expect(uploaded).toContain('Frozen first version');
  expect(uploaded).not.toContain('Later draft edit');
  const frozen = await getStore().getDoc<any>(jobPath);
  expect(frozen.git_publication.snapshot_digest).toBe(first.git_publication.snapshot_digest);
  expect(await executePublicationPhase(args)).toBe('waiting');
  expect(mocks.push).toHaveBeenCalledTimes(1);
});

it('stops a stale attempt before pushing its prepared tree and preserves the new owner', async () => {
  await executePublicationPhase(args);
  const targetPath = `${paths.site('org', 'site')}/publishing_targets/main`;
  mocks.source.mockImplementationOnce(async frozen => {
    await getStore().updateDoc(targetPath, { lease_id: 'new-worker', lease_until: Date.now() + 300000 });
    return { 'publication.json': JSON.stringify(frozen) };
  });
  expect(await executePublicationPhase(args)).toBe('deferred');
  expect(mocks.push).not.toHaveBeenCalled();
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'running' });
  expect(await getStore().getDoc(targetPath)).toMatchObject({ lease_id: 'new-worker' });
});

it.each(['cloudflare', 'github'] as const)('observes a queued %s build without regenerating source or probing hosting', async provider => {
  await executePublicationPhase(args);
  const job = await getStore().getDoc<any>(jobPath);
  await getStore().updateDoc(jobPath, { git_publication: { ...job.git_publication, build_task_key: 'task', build_provider: provider } });
  const { buildTasksPath } = await import('../../lib/builds/queue');
  await getStore().setDoc(`${buildTasksPath('org')}/task`, { status: 'running', deadline: Date.now() + 600000, media_total: 337, media_cursor: 200 });
  mocks.built.mockResolvedValueOnce(null);
  vi.clearAllMocks();
  expect(await executePublicationPhase(args)).toBe('waiting');
  expect(mocks.built).toHaveBeenCalledWith('org', 'task');
  expect(mocks.github).not.toHaveBeenCalled(); expect(mocks.cloudflare).not.toHaveBeenCalled();
  expect(mocks.source).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  expect(await getStore().getDoc(jobPath)).toMatchObject({ phase: 'preparing media: 200 of 337 files ready; continuing automatically' });
});

it('retries temporary provider failures from the saved source instead of accepting later edits', async () => {
  await executePublicationPhase(args);
  const frozen = await getStore().getDoc<any>(jobPath);
  mocks.github.mockRejectedValueOnce(new ProviderError('GitHub', 503));
  expect(await executePublicationPhase(args)).toBe('waiting');
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'running', coordinator_retries: 1 });
  await getStore().updateDoc(paths.page('org', 'site', 'home'), { html_content: 'Must not leak into the retry' });
  expect(await executePublicationPhase(args)).toBe('continue');
  expect(mocks.push.mock.calls.at(-1)![1].files['publication.json']).not.toContain('Must not leak');
  expect(await getStore().getDoc(jobPath)).toMatchObject({ coordinator_retries: 0, git_publication: { snapshot_digest: frozen.git_publication.snapshot_digest } });
});

it('resumes a timed-out public verification through the same job without provider mutations or a new build', async () => {
  await executeCustomerPublication(args); complete(); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  const store = getStore(), original = await store.getDoc<any>(jobPath);
  const publication = { ...original.git_publication, build_task_key: 'finished-build', verification_task_key: 'finished-verification', static_checks_key: 'full', probe_checks_key: 'probes', project_prepared: true };
  await store.updateDoc(jobPath, { status: 'failed', phase: 'failed', failure: { code: 'publication_observation_timeout', stage: 'waiting for updated static files' }, git_publication: publication });
  for (const key of ['finished-build', 'finished-verification']) await store.setDoc(`organizations/org/build_tasks/${key}`, { status: 'completed', identity: { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'job', publication_id: publication.publication_id, commit: publication.commit } });
  const { retryPublicationVerification } = await import('../../lib/publishing/verification-retry');
  expect(await retryPublicationVerification('org', 'site', 'job', 'main')).toMatchObject({ job_id: 'job', verification_only: true });
  const resumed = await store.getDoc<any>(jobPath);
  expect(resumed).toMatchObject({ status: 'running', git_publication: publication });
  expect(resumed.started_at).toBe(original.started_at);
  expect(resumed.verification_retry.failure.code).toBe('publication_observation_timeout');
  expect(await retryPublicationVerification('org', 'site', 'job', 'main')).toMatchObject({ already_running: true });
  for (const mock of [mocks.push, mocks.source, mocks.enqueue, mocks.upload, mocks.direct, mocks.cloudflare]) mock.mockClear();
  mocks.verify.mockResolvedValue(false);
  expect(await executePublicationPhase(args)).toBe('waiting');
  expect((await store.getDoc<any>(jobPath)).status).toBe('running');
  mocks.verify.mockResolvedValue(true);
  expect(await executePublicationPhase(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', phase: 'live', git_publication: publication });
  expect(await store.getDoc<any>(paths.version('org', 'site', 'main'))).toMatchObject({ last_deployed_content_at: publication.content_cutoff });
  for (const mock of [mocks.push, mocks.source, mocks.enqueue, mocks.upload, mocks.direct, mocks.cloudflare]) expect(mock).not.toHaveBeenCalled();
});

it('freezes a www redirect host, switches it after approval with the apex and verifies its 301 before going live', async () => {
  const store = getStore();
  const active = { website_host: 'old.example.com', media_host: null, media_path_prefix: '' };
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { active });
  const saved = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: saved.revision, website_host: 'moveria.se', redirect_hosts: ['www.moveria.se'], dns_mode: 'automatic' });
  const www: Array<Record<string, unknown>> = [{ id: 'www-a', type: 'A', name: 'www.moveria.se', content: '203.0.113.7', proxied: false }];
  let ruleset: any = null;
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route: string, options?: any) => {
    if (route.startsWith('/zones?') && route.includes('moveria.se')) return route.includes('name=moveria.se') ? [{ id: 'zone', name: 'moveria.se', status: 'active', account: { id: 'a'.repeat(32) } }] : [];
    if (route === '/zones/zone/ssl/verification') return [{ certificate_status: 'active' }];
    if (route === '/zones/zone/rulesets/phases/http_request_dynamic_redirect/entrypoint') return ruleset;
    if (route === '/zones/zone/rulesets' && options?.method === 'POST') { ruleset = { id: 'rs', rules: options.body.rules }; return ruleset; }
    if (route.startsWith('/zones/zone/dns_records?name=www.moveria.se')) return www;
    if (route === '/zones/zone/dns_records/www-a' && options?.method === 'PATCH') { www.splice(0, 1, { ...www[0], ...options.body }); return {}; }
    if (route.startsWith('/zones/zone/dns_records?name=moveria.se')) return [{ id: 'apex', name: 'moveria.se', type: 'CNAME', content: `${project}.pages.dev`, proxied: true }];
    return provider(route, options);
  });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  const frozen = JSON.parse(mocks.push.mock.calls[0][1].files['publication.json']);
  expect(frozen.reference_mapping.website_origins).toContain('https://www.moveria.se');
  expect((await store.getDoc<any>(jobPath)).git_publication.redirect_hosts).toEqual(['www.moveria.se']);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ phase: 'awaiting domain cutover approval', dns_requirements: expect.arrayContaining([expect.objectContaining({ type: 'A', name: 'www.moveria.se', content: '192.0.2.1', proxied: true })]) });
  // The rule exists while www is still DNS only at the old host; the record waits for approval.
  expect(ruleset.rules[0]).toMatchObject({ expression: 'http.host eq "www.moveria.se"', action: 'redirect' });
  expect(www[0]).toMatchObject({ content: '203.0.113.7', proxied: false });
  const prepared = await getSiteDomains('org', 'site');
  expect(prepared.redirect_preparations).toEqual([expect.objectContaining({ hostname: 'www.moveria.se', action: 'approve_cutover', certificate_ready: true, rule: expect.objectContaining({ status: 'configured' }) })]);
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { cutover_approved_revision: prepared.revision, approved_preparation: prepared.preparation, approved_redirect_preparations: prepared.redirect_preparations });
  expect((await store.getDoc<any>(jobPath)).git_publication.branch).toBe('main');
  redirectProbe.mockResolvedValueOnce({ ok: false, status: 200, location: null });
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(www[0]).toMatchObject({ type: 'A', content: '192.0.2.1', proxied: true });
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'waiting for www.moveria.se to redirect to moveria.se', verification_message: expect.stringContaining('must answer 301') });
  expect(redirectProbe).toHaveBeenLastCalledWith('www.moveria.se', 'moveria.se', expect.any(String));
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'succeeded', deploy_url: 'https://moveria.se', redirect_checks: [expect.objectContaining({ host: 'www.moveria.se', ok: true })] });
  expect((await getSiteDomains('org', 'site')).active).toEqual({ website_host: 'moveria.se', media_host: null, media_path_prefix: '', redirect_hosts: ['www.moveria.se'] });
});

it('stops a redirect change with a conflicting zone rule before asking for approval', async () => {
  const store = getStore();
  await store.updateDoc(siteDomainConfigPath('org', 'site'), { active: { website_host: 'www.example.com', media_host: null, media_path_prefix: '' } });
  const saved = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: saved.revision, website_host: 'www.example.com', redirect_hosts: ['example.com'], dns_mode: 'automatic' });
  const { redirectRuleSpec } = await import('../../lib/publishing/redirect-hosts');
  const spec = redirectRuleSpec('example.com', 'www.example.com', 'example.com');
  const provider = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route: string, options?: any) => {
    if (route.startsWith('/zones?')) return route.includes('name=example.com') ? [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'a'.repeat(32) } }] : [];
    if (route === '/zones/zone/ssl/verification') return [{ certificate_status: 'active' }];
    if (route === '/zones/zone/rulesets/phases/http_request_dynamic_redirect/entrypoint') return { id: 'rs', rules: [{ ref: spec.ref, action: 'redirect', expression: spec.expression, action_parameters: { from_value: { target_url: { value: 'https://elsewhere.example' }, status_code: 302 } } }] };
    if (route.startsWith('/zones/zone/dns_records?name=example.com')) return [{ id: 'apex', type: 'A', content: '192.0.2.44', proxied: false }];
    if (route.startsWith('/zones/zone/dns_records?name=www.example.com')) return [{ id: 'dns', name: new URL('https://api.invalid'+route).searchParams.get('name') ?? 'www.example.com', type: 'CNAME', content: `${project}.pages.dev`, proxied: true }];
    return provider(route, options);
  });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'awaiting domain cutover approval' });
  expect(await getSiteDomains('org','site')).toMatchObject({state:'preparing',redirect_preparations:[{blocker:{code:'redirect_rule_conflict'}}]});
  expect(mocks.cloudflare.mock.calls.some(([route, options]) => route.includes('/rulesets') && options?.method)).toBe(false);
  expect(mocks.cloudflare.mock.calls.some(([route, options]) => route.includes('/dns_records') && options?.method)).toBe(false);
});


async function installSyntheticDerivation() {
  const runtime = { installation_id: 'app', extension_id: 'org.example.provider', version: '1.0.0', public_config: { mapping: 'frozen' } };
  mocks.runtime.extensions.installations = [runtime];
  await getStore().setDoc(paths.extensionInstallation('org', 'site', 'app'), { id: 'app', developer_org_id: 'developer', extension_id: runtime.extension_id,
    status: 'enabled', granted_scopes: ['content:read'] });
  await getStore().setDoc(paths.extensionVersion('developer', runtime.extension_id, '1.0.0'), { status: 'published', manifest: {
    id: runtime.extension_id, version: '1.0.0', api: { base_url: 'https://provider.example/v1' },
    build_derivation: { input_format: 'frozen_publication_v1', path: '/derive', sources: ['example.records'], required: true },
  } });
  mocks.derive.mockImplementation(async (_url, request) => {
    const { derivationInputDigest } = await import('../../lib/publishing/build-derivation');
    return { status: 200, data: { input_digest: derivationInputDigest(request.body),
      sources: [{ id: 'example.records', records: [{ id: 'home', text: request.body.content.pages[0].title }] }],
      receipts: [{ kind: 'records', id: 'all', count: request.body.content.pages.length }] } };
  });
}
it.each(['cloudflare', 'github'] as const)('freezes derived output once before dispatch to %s and preserves live output on provider failure', async provider => {
  await installSyntheticDerivation();
  const store = getStore();
  await store.setDoc('organizations/org/publishing/build_selection', { provider, revision: 'selected' });
  await store.setDoc(`organizations/org/publishing_private/${provider === 'github' ? 'github_build_engine' : 'build_engine'}`, {
    status: 'ready', static_verification: true, provider, revision: 'engine', account_id: 'a'.repeat(32),
  });
  const cf = mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route, options) => route === `/accounts/${'a'.repeat(32)}/pages/projects/${project}`
    ? { name: project, production_branch: 'main' } : cf(route, options));
  mocks.enqueue.mockResolvedValue({ key: 'derived-task' }); mocks.built.mockResolvedValue(null);
  expect(await executePublicationPhase(args)).toBe('continue');
  await store.updateDoc(paths.page('org', 'site', 'home'), { title: 'Concurrent edit' });
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(mocks.derive).toHaveBeenCalledTimes(1);
  const frozen = JSON.parse(mocks.push.mock.calls[0][1].files['publication.json']);
  expect(frozen.derived['example.records']).toEqual([{ id: 'home', text: 'Home' }]);
  expect(frozen.pages[0].title).toBe('Home');
  expect(frozen.derivation.cache_keys.app).toMatch(/^[a-f0-9]{32}$/);
  // Finish the synthetic job without activating it, then exercise a new failure.
  await store.updateDoc(jobPath, { status: 'failed' });
  await store.updateDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { job_id: null, lease_id: null, lease_until: 0 });
  const failedArgs = { ...args, jobId: 'failed-derivation' };
  await store.setDoc(paths.deploy('org', 'site', failedArgs.jobId), { version_id: 'main', status: 'queued', environment: 'production' });
  const before = await store.getDoc(paths.site('org', 'site'));
  mocks.derive.mockResolvedValue({ status: 422, data: { error: 'Mapped field is missing' } });
  await executePublicationPhase(failedArgs);
  expect(await store.getDoc(paths.deploy('org', 'site', failedArgs.jobId))).toMatchObject({ status: 'failed', failure: { code: 'publication_derivation_failed' }, error: expect.stringContaining('Mapped field is missing') });
  expect(await store.getDoc(paths.site('org', 'site'))).toEqual(before);
  expect(mocks.push).toHaveBeenCalledTimes(1); expect(mocks.enqueue).toHaveBeenCalledTimes(1);
});


it('publishes to the active host without touching declared future hosts', async () => {
  const store=getStore();
  await store.updateDoc(siteDomainConfigPath('org','site'),{active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await executeCustomerPublication(args);
  const frozen=JSON.parse(mocks.push.mock.calls[0][1].files['publication.json']);
  expect(frozen.site_url).toBe('https://old.example.com');
  expect(mocks.push.mock.calls[0][1].branch).toBe('main');
  // Editing future configuration while this build is in flight cannot invalidate it.
  const initial=await getSiteDomains('org','site');
  await saveSiteDomains('org','site',{revision:initial.revision,website_host:'newer.example.com',dns_mode:'external'});
  complete();mocks.probe.mockResolvedValue(true);await executeCustomerPublication(args);
  expect(await store.getDoc(jobPath)).toMatchObject({status:'succeeded',deploy_url:'https://old.example.com'});
  expect(await getSiteDomains('org','site')).toMatchObject({active:{website_host:'old.example.com'},desired:{website_host:'newer.example.com'},candidate:null,state:'declared'});
  expect(mocks.cloudflare.mock.calls.some(([route])=>route.includes('newer.example.com'))).toBe(false);
});

it('publishes first to the temporary address even when future hosts have been entered', async () => {
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{active:null});
  const {getOrganizationDomains,saveOrganizationDomains}=await import('../../lib/publishing/domain-config');
  const organization=await getOrganizationDomains('org');
  await saveOrganizationDomains('org',{revision:organization.revision,sites_domain:'sites.example.com',media_host:'media.example.com',dns_mode:'automatic'});
  await executeCustomerPublication(args);
  const frozen=JSON.parse(mocks.push.mock.calls[0][1].files['publication.json']);
  expect(frozen.site_url).toBe(`https://site-${prefix}.sites.example.com`);
  expect(frozen.robots_blocked).toBe(true);
  expect(frozen.settings.sitewide_noindex).toBe(true);
  expect((await getSiteDomains('org','site')).desired.website_host).toBe('www.example.com');
  complete(); mocks.probe.mockResolvedValue(true); await executeCustomerPublication(args);
  expect(await getStore().getDoc(jobPath)).toMatchObject({status:'succeeded'});
  await getStore().setDoc(paths.deploy('org','site','second-temporary'), {version_id:'main',status:'queued'});
  mocks.deployment=null; mocks.probe.mockResolvedValue(false);
  await executeCustomerPublication({...args,jobId:'second-temporary'});
  const next = JSON.parse(mocks.push.mock.lastCall![1].files['publication.json']);
  expect(next.site_url).toBe(frozen.site_url);
  expect(next.robots_blocked).toBe(true);
});

it('reports noindex from the prepared published snapshot rather than later CMS settings', async () => {
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await getStore().updateDoc(paths.settings('org','site'),{sitewide_noindex:true});
  await prepareFromCurrentPublication();
  await getStore().updateDoc(paths.settings('org','site'),{sitewide_noindex:false});
  await executeCustomerPublication(args); complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  expect((await getSiteDomains('org','site')).candidate).toMatchObject({sitewide_noindex:true,robots_blocked:false});
});

it('clears authored noindex in the prepared snapshot when preparation was confirmed to disable it', async () => {
  await getStore().updateDoc(siteDomainConfigPath('org','site'),{active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await getStore().updateDoc(paths.settings('org','site'),{sitewide_noindex:true,sitewide_nofollow:true,scripts_head:'<meta name="robots" content="noindex, noarchive">'});
  await prepareFromCurrentPublication();
  await getStore().updateDoc(jobPath,{clear_authored_noindex:true});
  await executeCustomerPublication(args);
  const frozen=JSON.parse(mocks.push.mock.calls[0][1].files['publication.json']);
  expect(frozen).toMatchObject({authored_noindex:false,robots_blocked:false});
  expect(frozen.settings).toMatchObject({sitewide_noindex:false,sitewide_nofollow:false,scripts_head:'<meta name="robots" content="noarchive">'});
});

it('keeps future origins in normal publications before DNS and refreshes the main receipt', async () => {
  const store=getStore();
  await store.updateDoc(siteDomainConfigPath('org','site'),{active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await prepareFromCurrentPublication(); await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true); await executeCustomerPublication(args);
  const prepared=await getSiteDomains('org','site');
  expect(prepared.state).toBe('ready_to_switch');
  const {prepareDomainTransition} = await import('../../lib/publishing/domain-transition');
  expect(await prepareDomainTransition('org','site',{revision:prepared.revision})).toMatchObject({job_id:args.jobId,reused_candidate:true});
  expect((await store.getDoc<any>(`${paths.site('org','site')}/publishing_targets/main`)).job_id).toBeNull();
  await store.updateDoc(paths.page('org','site','home'),{html_content:'<h1>New current content</h1>'});
  const next={...args,jobId:'current-update'};
  await store.setDoc(paths.deploy('org','site',next.jobId),{version_id:'main',status:'queued'});
  mocks.deployment=null; mocks.probe.mockResolvedValue(false);
  await executeCustomerPublication(next); complete(); mocks.probe.mockResolvedValue(true); await executeCustomerPublication(next);
  expect(await store.getDoc(paths.deploy('org','site',next.jobId))).toMatchObject({status:'running',phase:'awaiting domain cutover approval',deploy_url:'https://old.example.com'});
  const updated=await getSiteDomains('org','site');
  expect(updated).toMatchObject({state:'ready_to_switch',published:{hosts:{website_host:'www.example.com'}},candidate:{job_id:'current-update'}});
  expect(updated.candidate!.id).not.toBe(prepared.candidate!.id);
  expect(JSON.parse(mocks.push.mock.calls.at(-1)![1].files['publication.json']).site_url).toBe('https://www.example.com');
  expect(await prepareDomainTransition('org','site',{revision:updated.revision})).toMatchObject({job_id:'current-update',reused_candidate:true});
  const {approveDomainCutover}=await import('../../lib/publishing/domain-config');
  await expect(approveDomainCutover('org','site',{revision:prepared.revision,candidate_id:prepared.candidate!.id})).rejects.toMatchObject({code:'domain_revision_conflict'});
  expect(await store.getDoc(jobPath)).toMatchObject({status:'succeeded',phase:'replaced by newer publication'});
});


it('rejects a superseded source before freezing or pushing a domain preparation', async () => {
  await getStore().updateDoc(jobPath, { publication_intent: 'domain_prepare', source_publication: { publication_id: 'older' } });
  await getStore().setDoc(`${paths.site('org', 'site')}/publishing_targets/main`, { job_id: null, lease_until: 0, last_publication: { publication_id: 'newer' } });
  await executeCustomerPublication(args);
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'domain_candidate_outdated' } });
  expect(mocks.push).not.toHaveBeenCalled();
});

it('requires explicit preparation instead of resuming an older automatically retargeted job', async () => {
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { active: { website_host: 'old.example.com', media_host: null, media_path_prefix: '' } });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  const current = await getStore().getDoc<any>(jobPath);
  await getStore().updateDoc(jobPath, { publication_intent: null, git_publication: { ...current.git_publication, destination: null } });
  mocks.push.mockClear();
  await executeCustomerPublication(args);
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'explicit_domain_preparation_required' } });
  expect(mocks.push).not.toHaveBeenCalled();
});

it('does not apply newly saved origins during a normal edit of the pending main publication', async () => {
  const store = getStore();
  await store.updateDoc(siteDomainConfigPath('org','site'), {active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await prepareFromCurrentPublication(); await executeCustomerPublication(args);
  complete(); mocks.probe.mockResolvedValue(true); await executeCustomerPublication(args);
  const prepared = await getSiteDomains('org','site');
  await saveSiteDomains('org','site', { revision: prepared.revision, website_host:'later.example.com', dns_mode:'automatic' });
  await store.updateDoc(paths.page('org','site','home'),{html_content:'<h1>Another update</h1>'});
  const next = {...args,jobId:'next-edit'};
  await store.setDoc(paths.deploy('org','site',next.jobId),{version_id:'main',status:'queued'});
  mocks.deployment=null; mocks.probe.mockResolvedValue(false); mocks.cloudflare.mockClear();
  await executeCustomerPublication(next); complete(); mocks.probe.mockResolvedValue(true); await executeCustomerPublication(next);
  expect(await store.getDoc(paths.deploy('org','site',next.jobId))).toMatchObject({status:'succeeded',deploy_url:'https://old.example.com'});
  expect(await getSiteDomains('org','site')).toMatchObject({desired:{website_host:'later.example.com'},published:{hosts:{website_host:'www.example.com'}},candidate:null});
  expect(JSON.parse(mocks.push.mock.calls.at(-1)![1].files['publication.json']).site_url).toBe('https://www.example.com');
  expect(mocks.cloudflare.mock.calls.some(([route,options])=>route.includes('/dns_records') && options?.method)).toBe(false);
});

it('waits for an actively approved DNS switch instead of replacing its artifact', async () => {
  const store = getStore();
  await store.updateDoc(siteDomainConfigPath('org','site'),{state:'distributing',candidate:{id:'approved',job_id:'dns-job'}});
  expect(await executeCustomerPublication(args)).toBe('deferred');
  expect(await store.getDoc(jobPath)).toMatchObject({waiting_for_job_id:'dns-job',phase:'waiting for the domain traffic switch'});
  expect((await store.getDoc<any>(`${paths.site('org','site')}/publishing_targets/main`)).job_id).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});

it('retains the main origins when domain setup fails after replacing the artifact', async () => {
  const store=getStore();
  await store.updateDoc(siteDomainConfigPath('org','site'),{active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await prepareFromCurrentPublication(); await executeCustomerPublication(args);
  complete(); mocks.probe.mockResolvedValue(true);
  const provider=mocks.cloudflare.getMockImplementation()!;
  mocks.cloudflare.mockImplementation(async (route,options)=> {
    if(route.includes('/domains/')) throw new ProviderError('Cloudflare',403,[9109]);
    return provider(route,options);
  });
  await executeCustomerPublication(args);
  expect(await store.getDoc(jobPath)).toMatchObject({status:'failed'});
  const domains=await getSiteDomains('org','site');
  expect(domains).toMatchObject({active:{website_host:'old.example.com'},published:{hosts:{website_host:'www.example.com'}}});
  const {activePublicationDomains}=await import('../../lib/publishing/domain-config');
  expect(activePublicationDomains(domains).desired.website_host).toBe('www.example.com');
});

it('requires fresh approval after a failed switch even when the embedded origins are unchanged', async () => {
  const store=getStore();
  await store.updateDoc(siteDomainConfigPath('org','site'),{active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await prepareFromCurrentPublication(); await executeCustomerPublication(args);
  complete(); mocks.probe.mockResolvedValue(true); await executeCustomerPublication(args);
  const before=await getSiteDomains('org','site');
  const previous=(await store.getDoc<any>(`${paths.site('org','site')}/publishing_targets/main`)).last_publication;
  await store.updateDoc(siteDomainConfigPath('org','site'),{state:'failed',rollback_status:'rolled_back',cutover_approved_revision:before.revision,approved_preparation:before.preparation});
  const next={...args,jobId:'after-rollback'};
  await store.setDoc(paths.deploy('org','site',next.jobId),{status:'queued',version_id:'main',publication_intent:'domain_prepare',domain_revision:before.revision,source_publication:previous});
  mocks.deployment=null; mocks.probe.mockResolvedValue(false); mocks.cloudflare.mockClear();
  await executeCustomerPublication(next); complete(); mocks.probe.mockResolvedValue(true); await executeCustomerPublication(next);
  const after=await getSiteDomains('org','site');
  expect(after.candidate!.id).not.toBe(before.candidate!.id);
  expect(after).toMatchObject({state:'ready_to_switch',cutover_approved_revision:null});
  expect(await store.getDoc(paths.deploy('org','site',next.jobId))).toMatchObject({phase:'awaiting domain cutover approval'});
  expect(mocks.cloudflare.mock.calls.some(([route,options])=>route.includes('/dns_records') && options?.method)).toBe(false);
});

it('finishes legacy previous-host redirects through normal publication after public verification', async () => {
  const old = 'site-123.sites.example.com';
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { media_aliases: [{ website_host: old, media_host: null, media_path_prefix: '' }] });
  const provider = mocks.cloudflare.getMockImplementation()!;
  const rules: any[] = [];
  mocks.cloudflare.mockImplementation(async (route, options) => {
    if (route.includes('/rulesets')) {
      if (!options?.method) return { id: 'ruleset', rules: structuredClone(rules) };
      expect(mocks.probe.mock.calls.some(([origin]) => origin === 'https://www.example.com')).toBe(true);
      rules.push(options.body);
      return { id: 'new-rule' };
    }
    return provider(route, options);
  });
  await executeCustomerPublication(args);
  expect(rules).toHaveLength(0);
  complete(); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  expect(await getStore().getDoc(jobPath)).toMatchObject({ status: 'succeeded' });
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ expression: `http.host eq "${old}"`, action_parameters: { from_value: { status_code: 301, preserve_query_string: true } } });
  expect((await getSiteDomains('org', 'site')).previous_hosts).toMatchObject([{ host: old, mode: 'redirect', status: 'verified' }]);
  expect(mocks.cloudflare.mock.calls.some(([route, options]) => route.includes('/dns_records') && options?.method)).toBe(false);
  expect(mocks.push).toHaveBeenCalledTimes(1);
  // Reach the stable unchanged snapshot, then model a permission repair after
  // an earlier noindex fallback. Finishing retirement must not push/build again.
  let unchanged = false;
  for (let i = 0; i < 3 && !unchanged; i++) {
    const next = { ...args, jobId: `repeat-${i}` };
    await getStore().setDoc(paths.deploy('org', 'site', next.jobId), { version_id: 'main', status: 'queued', environment: 'production', started_at: new Date().toISOString() });
    await executeCustomerPublication(next);
    unchanged = (await getStore().getDoc<any>(paths.deploy('org', 'site', next.jobId))).phase === 'unchanged';
  }
  expect(unchanged).toBe(true);
  rules.length = 0;
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { previous_hosts: [{ host: old, target_host: 'www.example.com', mode: 'noindex', status: 'warning' }] });
  const repair = { ...args, jobId: 'repair' }, pushes = mocks.push.mock.calls.length;
  await getStore().setDoc(paths.deploy('org', 'site', repair.jobId), { version_id: 'main', status: 'queued', environment: 'production', started_at: new Date().toISOString() });
  await executeCustomerPublication(repair);
  expect((await getStore().getDoc<any>(paths.deploy('org', 'site', repair.jobId))).status).toBe('succeeded');
  expect(rules).toHaveLength(1);
  expect(mocks.push).toHaveBeenCalledTimes(pushes);
});

it('records the actual replaced origins even if future settings change during the provider request', async () => {
  const store=getStore();
  await store.updateDoc(siteDomainConfigPath('org','site'),{active:{website_host:'old.example.com',media_host:null,media_path_prefix:''}});
  await prepareFromCurrentPublication(); await executeCustomerPublication(args);
  complete(); mocks.probe.mockResolvedValue(true);
  const before=await getSiteDomains('org','site');
  const provider=mocks.cloudflare.getMockImplementation()!;
  let changed=false;
  mocks.cloudflare.mockImplementation(async (route,options)=> {
    if(!changed) {
      changed=true;
      await saveSiteDomains('org','site',{revision:before.revision,website_host:'later.example.com',dns_mode:'automatic'});
    }
    return provider(route,options);
  });
  await executeCustomerPublication(args);
  expect(await store.getDoc(jobPath)).toMatchObject({status:'failed',failure:{code:'domain_revision_conflict'}});
  expect(await getSiteDomains('org','site')).toMatchObject({desired:{website_host:'later.example.com'},published:{hosts:{website_host:'www.example.com'},job_id:args.jobId},cutover_approved_revision:null});
});

it.each([{ corrected: true, legacy: false }, { corrected: false, legacy: false }, { corrected: true, legacy: true }])('recovers a stale public asset without rebuilding: %j', async ({ corrected, legacy }) => {
  await executeCustomerPublication(args); complete(); mocks.probe.mockResolvedValue(true);
  await executeCustomerPublication(args);
  const store = getStore(), original = await store.getDoc<any>(jobPath);
  const publication = { ...original.git_publication, build_task_key: 'finished-build', verification_task_key: 'finished-verification', static_checks_key: 'full', probe_checks_key: 'probes', project_prepared: true };
  await store.updateDoc(jobPath, { status: 'running', git_publication: publication });
  for (const key of ['finished-build', 'finished-verification']) await store.setDoc(`organizations/org/build_tasks/${key}`, { status: 'completed', identity: { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'job', publication_id: publication.publication_id, commit: publication.commit } });
  mocks.verify.mockImplementation(async (_org, path, _checks, origin) => {
    await store.updateDoc(path, { static_probe: { origin, route: '/media/removed.svg', expected_status: 404, actual_status: 200, reason: 'status_mismatch', response_headers: { cf_cache_status: 'MISS', age: 180000 } } });
    return false;
  });
  for (const mock of [mocks.push, mocks.source, mocks.enqueue, mocks.upload, mocks.direct, mocks.cloudflare]) mock.mockClear();
  const { retryPublicationVerification } = await import('../../lib/publishing/verification-retry');
  if (legacy) {
    await store.updateDoc(jobPath, { status: 'failed', failure: { code: 'publication_observation_timeout' } });
    await retryPublicationVerification('org', 'site', 'job', 'main');
  } else {
    expect(await executePublicationPhase(args)).toBe('waiting');
    expect(mocks.cloudflare).toHaveBeenCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { prefixes: ['www.example.com/media/removed.svg'] } });
    for (let i = 0; i < 5; i++) expect(await executePublicationPhase(args)).toBe('waiting');
  }
  expect(await executePublicationPhase(args)).toBe('ran');
  expect(await store.getDoc(jobPath)).toMatchObject({ status: 'failed', failure: { code: 'publication_cache_refresh_required' }, cache_recovery: { state: 'approval_required' } });
  expect(mocks.cloudflare.mock.calls.filter(([, opts]) => opts?.body?.purge_everything)).toHaveLength(0);
  await retryPublicationVerification('org', 'site', 'job', 'main', 'zone');
  expect(await executePublicationPhase(args)).toBe('waiting');
  expect(mocks.cloudflare).toHaveBeenCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { purge_everything: true } });
  expect(await store.getDoc(jobPath)).toMatchObject({ status: 'running' }); // API success is not publication proof
  if (corrected) mocks.verify.mockResolvedValue(true);
  else for (let i = 0; i < 5; i++) expect(await executePublicationPhase(args)).toBe('waiting');
  expect(await executePublicationPhase(args)).toBe('ran');
  expect(await store.getDoc(jobPath)).toMatchObject({ status: corrected ? 'succeeded' : 'failed', git_publication: publication,
    ...(!corrected ? { failure: { code: 'publication_cache_refresh_failed' } } : {}) });
  expect(mocks.cloudflare.mock.calls.filter(([, opts]) => opts?.body?.purge_everything)).toHaveLength(1);
  expect(mocks.cloudflare.mock.calls.filter(([, opts]) => opts?.method && opts.method !== 'GET').every(([path]) => path.endsWith('/purge_cache'))).toBe(true);
  for (const mock of [mocks.push, mocks.source, mocks.enqueue, mocks.upload, mocks.direct]) expect(mock).not.toHaveBeenCalled();
});

it('refreshes a stale cached file at the current address during domain preparation, path by path', async () => {
  const active = { website_host: 'old.example.com', media_host: null, media_path_prefix: '' };
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { active });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  const store = getStore();
  const pending = await store.getDoc<any>(jobPath);
  await store.updateDoc(jobPath, { git_publication: { ...pending.git_publication, static_checks_key: 'full', probe_checks_key: 'probes' } });
  let stale = true;
  mocks.verify.mockImplementation(async (_org, path, _checks, origin) => {
    if (!stale || origin !== 'https://old.example.com') return true;
    await store.updateDoc(path, { static_probe: { origin, route: '/_typeroll/fonts/removed.woff2', expected_status: 404, actual_status: 200, reason: 'status_mismatch', response_headers: { cf_cache_status: 'MISS', age: 22570 } } });
    return false;
  });
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(mocks.cloudflare).toHaveBeenCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { prefixes: ['old.example.com/_typeroll/fonts/removed.woff2'] } });
  expect(mocks.cloudflare.mock.calls.filter(([, opts]) => opts?.body?.purge_everything)).toHaveLength(0);
  stale = false;
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'awaiting domain cutover approval' });
  expect((await getSiteDomains('org', 'site')).candidate).toMatchObject({ job_id: args.jobId });
  expect(mocks.push).toHaveBeenCalledTimes(1);
});

it('lets a domain preparation blocked by a stale cache resume after an approved zone refresh', async () => {
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), { active: { website_host: 'old.example.com', media_host: null, media_path_prefix: '' } });
  await prepareFromCurrentPublication();
  await executeCustomerPublication(args);
  complete(mocks.push.mock.calls[0][1].branch); mocks.probe.mockResolvedValue(true);
  const store = getStore(), pending = await store.getDoc<any>(jobPath);
  const publication = { ...pending.git_publication, build_task_key: 'finished-build', verification_task_key: 'finished-verification', static_checks_key: 'full', probe_checks_key: 'probes' };
  await store.updateDoc(jobPath, { git_publication: publication });
  let stale = true;
  mocks.verify.mockImplementation(async (_org, path, _checks, origin) => {
    if (!stale || origin !== 'https://old.example.com') return true;
    await store.updateDoc(path, { static_probe: { origin, route: '/_typeroll/fonts/removed.woff2', expected_status: 404, actual_status: 200, reason: 'status_mismatch', response_headers: { cf_cache_status: 'MISS', age: 22570 } } });
    return false;
  });
  let result: string;
  for (let i = 0; (result = await executeCustomerPublication(args)) === 'waiting' && i < 30; i++);
  const failed = await store.getDoc<any>(jobPath);
  expect(failed).toMatchObject({ status: 'failed', failure: { code: 'publication_cache_refresh_required' }, cache_recovery: { state: 'approval_required', hostname: 'old.example.com' } });
  for (const key of ['finished-build', 'finished-verification']) await store.setDoc(`organizations/org/build_tasks/${key}`, { status: 'completed', identity: { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'job', publication_id: failed.git_publication.publication_id, commit: failed.git_publication.commit } });
  const { retryPublicationVerification } = await import('../../lib/publishing/verification-retry');
  await retryPublicationVerification('org', 'site', 'job', 'main', 'zone');
  expect(await executeCustomerPublication(args)).toBe('waiting');
  expect(mocks.cloudflare).toHaveBeenCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { purge_everything: true } });
  stale = false;
  expect(await executeCustomerPublication(args)).toBe('ran');
  expect(await store.getDoc<any>(jobPath)).toMatchObject({ status: 'running', phase: 'awaiting domain cutover approval' });
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect(mocks.cloudflare.mock.calls.some(([, options]) => options?.method === 'PATCH' && options?.body?.type === 'CNAME')).toBe(false);
});
