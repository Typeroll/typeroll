import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath } from '../../lib/publishing/connections';
import { getSiteDomains, saveSiteDomains, siteDomainConfigPath } from '../../lib/publishing/domain-config';
import { executeCustomerPublication } from '../../lib/publishing/customer-runner';
import { ProviderError } from '../../lib/publishing/providers.mjs';

const mocks = vi.hoisted(() => ({ github: vi.fn(), cloudflare: vi.fn(), push: vi.fn(), probe: vi.fn(), source: vi.fn(), deployment: null as any }));
vi.mock('../../lib/publishing/github-connection', () => ({ githubConfiguration: () => ({ appId: '12', privateKey: 'synthetic-only' }) }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => mocks.cloudflare }));
vi.mock('../../lib/publishing/providers.mjs', async importOriginal => ({ ...await importOriginal<object>(), githubInstallationClient: async () => mocks.github, publishTree: mocks.push }));
vi.mock('../../lib/publishing/source-tree', () => ({ publicationSourceTree: mocks.source }));
vi.mock('../../lib/publishing/runtime-projection', () => ({ publicationRuntime: async () => ({ forms: [], apps: { apps: {} }, extensions: { installations: [] }, dependencies: [] }) }));
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
