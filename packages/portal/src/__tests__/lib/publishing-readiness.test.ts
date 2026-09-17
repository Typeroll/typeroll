import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { publishingReadiness } from '../../lib/publishing/readiness';
import { readBuildSettings, selectionPath } from '../../lib/builds/selection';
import { engineConfigurationPath } from '../../lib/builds/state';
import { enginePath } from '../../lib/builds/cloudflare';
import { connectionPath } from '../../lib/publishing/connections';
import { organizationDomainConfigPath, siteDomainConfigPath } from '../../lib/publishing/domain-config';
import { FirestoreDeployQueue, FIRESTORE_DEPLOY_QUEUE_PATH } from '../../lib/deploy/queue';
import { POST as deployUi } from '../../pages/api/sites/[siteId]/deploy';
import { POST as deployApi } from '../../pages/api/v1/sites/[siteId]/deploy';
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(), requireSiteAccess: async () => ({ ok: true, value: { owner_org_id: 'org', site: { id: 'site' }, versionId: 'main', session: {} } }), requirePermission: () => ({ ok: true }) }));
vi.mock('../../lib/api-auth', async original => ({ ...await original<typeof import('../../lib/api-auth')>(), requireApiKey: async () => ({ ok: true, value: { orgId: 'org', siteId: 'site', versionId: 'main', permission: 'admin' } }) }));
async function engine(provider: 'cloudflare' | 'github' = 'cloudflare', extra = {}) {
  await getStore().setDoc(enginePath('org', provider), { provider, state: 'ready', enabled: true });
  await getStore().setDoc(engineConfigurationPath('org', provider), { provider, status: 'ready', revision: 'engine', account_id: 'cf-account', installation_id: 'installation', owner: 'owner', github: { owner_id: 'github-account' }, static_verification: true, media_preparation: true, ...extra });
}
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); const store = getStore();
  await store.setDoc(paths.site('org', 'site'), { publishing_mode: 'customer_git' });
  await store.setDoc(connectionPath('org', 'github'), { status: 'connected', github: { installation_id: 'installation', account_id: 'github-account', owner: 'owner' } });
  await store.setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', cloudflare: { account_id: 'cf-account' } });
  await store.setDoc(organizationDomainConfigPath('org'), { revision: 'domains', sites_domain: 'sites.example.com' });
  await engine();
});
it('blocks an outdated engine even when its saved visible status says ready', async () => {
  await engine('cloudflare', { static_verification: false });
  const result = await publishingReadiness('org', 'site');
  expect(result.ready).toBe(false);
  expect(result.required).toEqual([{ code: 'build_engine_update_required', message: expect.stringContaining('Update the build engine'), settings_url: '/app/settings/publishing#publishing-builds' }]);
  expect(await readBuildSettings('org')).toMatchObject({ enabled: false, state: 'setup_required' });
});
it.each(['preparing', 'qualifying', 'disabled'])('blocks an engine in %s state', async status => {
  await engine('cloudflare', { status });
  expect((await publishingReadiness('org', 'site')).required).toContainEqual(expect.objectContaining({ code: 'build_setup_required' }));
});
it('requires the selected provider and its current connections', async () => {
  await getStore().setDoc(selectionPath('org'), { provider: 'github', revision: 'selection' });
  expect((await publishingReadiness('org', 'site')).ready).toBe(false);
  await engine('github'); expect((await publishingReadiness('org', 'site')).ready).toBe(true);
  await engine('github', { account_id: 'old-account' });
  expect((await publishingReadiness('org', 'site')).required).toContainEqual(expect.objectContaining({ code: 'build_connection_changed' }));
});
it('checks the version host without requiring traffic cutover before the first candidate', async () => {
  await getStore().setDoc(organizationDomainConfigPath('org'), { sites_domain: null });
  await getStore().setDoc(siteDomainConfigPath('org', 'site'), { desired: { website_host: 'www.example.com' }, state: 'declared' });
  expect((await publishingReadiness('org', 'site')).ready).toBe(true);
  expect((await publishingReadiness('org', 'site', 'new-version')).required).toContainEqual(expect.objectContaining({ code: 'publishing_domain_required' }));
});
it('requires media setup where needed and preserves managed-site publishing', async () => {
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png' });
  expect((await publishingReadiness('org', 'site')).required.map(item => item.code)).toEqual(['media_storage_required', 'media_domain_required']);
  await getStore().setDoc(paths.site('org', 'site'), { publishing_mode: 'managed' });
  expect((await publishingReadiness('org', 'site')).ready).toBe(true);
});
it.each([['UI', deployUi], ['API/MCP', deployApi]] as const)('rejects %s deployment before creating a job', async (_label, route) => {
  await engine('cloudflare', { static_verification: false });
  const response = await route({ params: { siteId: 'site' }, request: new Request('http://localhost/deploy', { method: 'POST', body: '{}' }), cookies: {}, locals: {} } as any);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'publishing_setup_required', required: [{ code: 'build_engine_update_required' }] });
  expect(await getStore().listDocs(paths.deploys('org', 'site'))).toEqual([]);
});

it('blocks queue admissions but allows an accepted publication continuation to use its frozen engine', async () => {
  await engine('cloudflare', { static_verification: false });
  const queue = new FirestoreDeployQueue();
  const args = { orgId: 'org', siteId: 'site', versionId: 'main', jobId: 'accepted', environment: 'production' as const };
  await expect(queue.enqueue(args)).rejects.toMatchObject({ code: 'publishing_setup_required' });
  expect(await getStore().listDocs(FIRESTORE_DEPLOY_QUEUE_PATH)).toEqual([]);
  await queue.enqueue({ ...args, dispatchKey: 'a'.repeat(16) });
  expect(await getStore().listDocs(FIRESTORE_DEPLOY_QUEUE_PATH)).toHaveLength(1);
  await getStore().setDoc(connectionPath('org', 'github'), { status: 'disconnected' });
  await expect(queue.enqueue({ ...args, dispatchKey: 'b'.repeat(16) })).rejects.toMatchObject({ code: 'publishing_setup_required' });
});

it('blocks invalid IDs and unknown block exports before a job is created, including managed sites', async () => {
  const store = getStore();
  const pagePath = `${paths.pages('org', 'site', 'main')}/broken`;
  await store.setDoc(pagePath, { content_mode: 'blocks', status: 'published', blocks: [{ type: 'core/prose', data: {} }] });
  let result = await publishingReadiness('org', 'site');
  expect(result.ready).toBe(false);
  expect(result.required).toContainEqual(expect.objectContaining({ code: 'content_export_invalid', message: expect.stringContaining('pages/broken.blocks[0].id') }));
  await store.setDoc(paths.site('org', 'site'), { publishing_mode: 'managed' });
  expect((await publishingReadiness('org', 'site')).ready).toBe(false);
  await store.updateDoc(pagePath, { blocks: [{ id: 'b', type: 'missing/block', data: {} }] });
  expect((await publishingReadiness('org', 'site')).required[0].message).toContain('Unsupported publication block type');
  await store.updateDoc(pagePath, { blocks: [{ id: 'b', type: 'core/repeater', data: { item_block: 'missing-card' } }] });
  expect((await publishingReadiness('org', 'site')).required[0].message).toContain('blocks[0].data.item_block');
  await store.updateDoc(pagePath, { blocks: [{ id: 'b', type: 'core/prose', data: { html: '<p>Ready</p>' } }] });
  expect((await publishingReadiness('org', 'site')).ready).toBe(true);
});

it('checks the inherited template and block arrays without treating drafts as public content', async () => {
  const store = getStore(), pagePath = `${paths.pages('org', 'site', 'main')}/profile`;
  await store.setDoc(pagePath, { content_mode: 'blocks', status: 'draft', blocks: [null] });
  expect((await publishingReadiness('org', 'site')).ready).toBe(true);
  await store.setDoc(pagePath, { content_mode: 'blocks', status: 'published' });
  expect((await publishingReadiness('org', 'site')).required[0].message).toContain('blocks must be an array');
  await store.updateDoc(pagePath, { blocks: [], template: 'missing' });
  expect((await publishingReadiness('org', 'site')).required[0].message).toContain('page_templates/missing');
});
