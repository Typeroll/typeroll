import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { assignHostingGroup, lockSiteHostingGroup, getHostingGroup, listHostingGroups, saveHostingGroup, siteHostingGroup } from '../../lib/publishing/hosting-groups';
import { connectionPath, getConnection, openCredentials, sealCredentials } from '../../lib/publishing/connections';
import { updateHostingConnection } from '../../lib/publishing/hosting-connection';
import { cloudflareClient, finishCloudflareConnection, startCloudflareConnection } from '../../lib/publishing/cloudflare-oauth';
import { preparePagesDomain } from '../../lib/publishing/domain-provider';
import { publicationMediaManifest } from '../../lib/publishing/media-manifest';

const account1 = 'a'.repeat(32), account2 = 'b'.repeat(32);
const session = { orgId: 'org', userId: 'synthetic-user', email: 'test@example.invalid' };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-client-secret');
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Test', publishing_mode: 'customer_git', media_id: 'abcdefghij' });
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'original', media_ready: true,
    cloudflare: { account_id: account1, bucket: 'originals', public_bucket: 'public' },
    encrypted_credentials: sealCredentials('org', 'cloudflare', { api_token: 'synthetic-original' }) });
  await getStore().setDoc('organizations/org/publishing/domains', { revision: 'domains', sites_domain: 'sites.example.com', media_host: 'media.example.com', dns_mode: 'automatic' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const create = () => saveHostingGroup('org', { name: 'Hosting 2', sites_domain: 'sites2.example.com', dns_mode: 'automatic' });

it('initializes Default idempotently without copying credentials or moving media and domains', async () => {
  const connection = await getConnection('org', 'cloudflare');
  await getHostingGroup('org'); await getHostingGroup('org');
  expect(await siteHostingGroup('org', 'site')).toMatchObject({ id: 'default', sites_domain: 'sites.example.com', revision: 'domains' });
  expect(await getConnection('org', 'cloudflare', 'default')).toEqual(connection);
  expect(connectionPath('org', 'cloudflare', 'default')).toBe(connectionPath('org', 'cloudflare'));
  expect(await getStore().listDocs('organizations/org/hosting_groups')).toHaveLength(1);
  expect(JSON.stringify(await listHostingGroups('org'))).not.toContain('synthetic-original');
});

it('rejects foreign groups and stale assignment, and refuses implicit migration of published sites', async () => {
  const group = await create();
  await expect(getHostingGroup('other', group.id)).rejects.toMatchObject({ status: 404 });
  await expect(assignHostingGroup('org', 'site', { hosting_group_id: group.id, previous_group_id: 'wrong' })).rejects.toMatchObject({ status: 409 });
  await assignHostingGroup('org', 'site', { hosting_group_id: group.id, previous_group_id: 'default' });
  expect((await siteHostingGroup('org', 'site')).id).toBe(group.id);
  await getStore().setDoc(paths.deploy('org', 'site', 'old'), { status: 'succeeded', git_publication: { commit: 'c'.repeat(40) } });
  await expect(assignHostingGroup('org', 'site', { hosting_group_id: 'default', previous_group_id: group.id })).rejects.toMatchObject({ code: 'hosting_migration_required' });
});

it('seals credentials to the organization and group, including independent provider access', async () => {
  const group = await create();
  const before = await getConnection('org', 'cloudflare');
  const revision = (await getConnection('org', 'cloudflare', group.id)).revision;
  const provider = vi.fn<typeof fetch>(async url => Response.json({ success: true, result: String(url).includes('/pages/') ? [] : { id: account2, name: 'Second account' } }));
  await updateHostingConnection('org', { hosting_group_id: group.id, revision, action: 'connect', account_id: account2, api_token: 'synthetic-second' }, provider);
  const saved = await getConnection('org', 'cloudflare', group.id);
  expect(await getConnection('org', 'cloudflare')).toEqual(before);
  expect(() => openCredentials('org', 'cloudflare', saved.encrypted_credentials!)).toThrow();
  expect(() => openCredentials('other', 'cloudflare', saved.encrypted_credentials!, group.id)).toThrow();
  expect(openCredentials('org', 'cloudflare', saved.encrypted_credentials!, group.id)).toEqual({ api_token: 'synthetic-second' });
  const client = await cloudflareClient('org', provider, undefined, group.id);
  await client(`/accounts/${account2}/pages/projects`);
  expect(new Headers(provider.mock.calls.at(-1)![1]?.headers).get('Authorization')).toBe('Bearer synthetic-second');
  expect(provider.mock.calls.some(([url]) => String(url).includes('/r2/'))).toBe(false);
});

it('completes hosting-only OAuth against its group without rotating or overwriting Default', async () => {
  const group = await create();
  const before = await getConnection('org', 'cloudflare');
  const start = await startCloudflareConnection(session, group.id);
  const url = new URL(start.url);
  expect(url.searchParams.get('scope')).not.toContain('workers-r2');
  const provider = vi.fn<typeof fetch>(async url => {
    const address = String(url);
    if (address.endsWith('/oauth2/token')) return Response.json({ token_type: 'bearer', access_token: 'synthetic-oauth', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'account-settings.read page.read page.write offline_access' });
    const result = address.includes('/accounts?') ? [{ id: account2, name: 'Second account' }] : address.includes('/pages/') ? [] : { id: account2, name: 'Second account' };
    return Response.json({ success: true, result });
  });
  expect(await finishCloudflareConnection(session, { state: url.searchParams.get('state')!, browser: start.browser, code: 'synthetic-code' }, provider)).toBe('connected');
  expect((await getConnection('org', 'cloudflare', group.id)).cloudflare?.account_id).toBe(account2);
  expect(await getConnection('org', 'cloudflare')).toEqual(before);
});

it('registers Pages in the hosting account and changes only the separate DNS account', async () => {
  const hosting = vi.fn(async (_route: string, _options?: any) => ({ status: 'active' }));
  const dns = vi.fn(async (route: string, options?: any) => route.startsWith('/zones?') ? [{ id: 'zone1', name: 'example.com', status: 'active', account: { id: account1 } }] : options?.method ? {} : []);
  const result = await preparePagesDomain(hosting, { accountId: account2, project: 'typeroll-test', branch: 'main', hostname: 'site.sites2.example.com', dnsMode: 'automatic', dnsProvider: dns, dnsAccountId: account1 });
  expect(hosting).toHaveBeenCalledWith(`/accounts/${account2}/pages/projects/typeroll-test/domains/site.sites2.example.com`, { missing: true });
  expect(dns).toHaveBeenCalledWith('/zones/zone1/dns_records', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ name: 'site.sites2.example.com', content: 'typeroll-test.pages.dev' }) }));
  expect(result.action).toBe('verify');
  expect(hosting.mock.calls.some(call => String(call[0]).startsWith('/zones'))).toBe(false);
});

it('packages only referenced organization media on a second group website and retains shared URLs', async () => {
  const group = await create();
  await assignHostingGroup('org', 'site', { hosting_group_id: group.id, previous_group_id: 'default' });
  for (const id of ['used', 'unused']) await getStore().setDoc(`${paths.media('org', 'site')}/${id}`, { filename: `${id}.png`, mime_type: 'image/png', cdn_url: `https://media.example.com/${id}.png`, sha256: 'd'.repeat(64),
    storage: { provider: 'organization_r2', state: 'ready', account_id: account1, bucket: 'originals', key: `private/media/abcdefghij/originals/${id}.png` } });
  const result = await publicationMediaManifest('org', 'site', { html: '<img src="https://media.example.com/used.png">' }, 'site.sites2.example.com');
  expect(result.manifest?.account_id).toBe(account1);
  expect(result.manifest?.media_host).toBe('site.sites2.example.com');
  expect(result.media.map(item => item.id)).toEqual(['used']);
  expect(result.content.html).toContain('https://site.sites2.example.com/media/');
  expect(result.media[0].aliases[0].url).toContain('https://media.example.com/media/abcdefghij/');
});

it('serializes the first publication against group assignment before a Git commit exists', async () => {
  const group = await create();
  await lockSiteHostingGroup('org', 'site');
  await expect(assignHostingGroup('org', 'site', { hosting_group_id: group.id, previous_group_id: 'default' })).rejects.toMatchObject({ code: 'hosting_migration_required' });
  expect((await siteHostingGroup('org', 'site')).id).toBe('default');
});

it('does not change shared media when saving a Default site address base', async () => {
  const group = await getHostingGroup('org');
  await saveHostingGroup('org', { id: 'default', name: 'Default', revision: group.revision, sites_domain: 'new-sites.example.com', dns_mode: 'automatic' });
  expect(await getStore().getDoc('organizations/org/publishing/domains')).toMatchObject({ sites_domain: 'new-sites.example.com', media_host: 'media.example.com' });
  await expect(saveHostingGroup('org', { id: 'default', name: 'Default', revision: group.revision, sites_domain: 'stale.example.com', dns_mode: 'automatic' })).rejects.toMatchObject({ status: 409 });
});
