import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getSiteDomains, saveSiteDomains, getOrganizationDomains, saveOrganizationDomains } from '../../lib/publishing/domain-config';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { requestMediaMigration, runMediaMigrationBatch, mediaMigrationStatus, rewriteMediaReferences } from '../../lib/publishing/media-migration';
import { preparePublicMediaDomains } from '../../lib/publishing/media-domain';
import { publicationMediaManifest } from '../../lib/publishing/media-manifest';
vi.mock('../../lib/publishing/media-domain', () => ({ preparePublicMediaDomains: vi.fn(async () => true) }));
const sha = createHash('sha256').update('abc').digest('hex');
const oldUrl = 'https://cms.example.com/api/sites/site/media/image/content';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.mocked(preparePublicMediaDomains).mockReset().mockResolvedValue(true);
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32)); vi.stubEnv('R2_PRIVATE_BUCKET', 'private-drafts');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-key'); vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-secret');
  await getStore().setDoc(paths.site('org', 'site'), { media_id: 'abcdefghij', publishing_mode: 'customer_git' });
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { revision: 'connected', status: 'connected', media_ready: true,
    cloudflare: { account_id: 'a'.repeat(32), bucket: 'customer-private', public_bucket: 'customer-public' },
    encrypted_credentials: sealCredentials('org', 'cloudflare', { access_key_id: 'synthetic-key', secret_access_key: 'synthetic-secret' }) });
  const config = await getOrganizationDomains('org');
  await saveOrganizationDomains('org', { revision: config.revision, sites_domain: 'demos.example.com', media_host: 'media.example.net', dns_mode: 'external' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('verifies bytes before switching storage and preserves an edit made while copying', async () => {
  const mediaPath = `${paths.media('org', 'site')}/image`;
  await getStore().setDoc(mediaPath, { filename: 'image.png', mime_type: 'image/png', alt_text: 'Before copy', cdn_url: oldUrl, r2_key: 'original', sha256: sha,
    storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: 'original', state: 'ready', generation: 'draft' } });
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
    if (command instanceof PutObjectCommand) {
      expect((await getStore().getDoc<any>(mediaPath)).storage.provider).toBe('draft_r2');
      await getStore().updateDoc(mediaPath, { alt_text: 'Edited during copy' });
    }
    return { Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3 };
  });
  await requestMediaMigration('org'); await runMediaMigrationBatch('org');
  expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(2);
  expect(await getStore().getDoc<any>(mediaPath)).toMatchObject({ alt_text: 'Edited during copy', storage: { provider: 'organization_r2', state: 'ready' }, sha256: sha, migration_source: { key: 'original' } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 1, copied_bytes: 3 });
});

it('does not switch an original whose destination fails byte verification', async () => {
  const mediaPath = `${paths.media('org', 'site')}/image`;
  await getStore().setDoc(mediaPath, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, r2_key: 'original', sha256: sha,
    storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: 'original', state: 'ready', generation: 'draft' } });
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => ({ Body: { transformToByteArray: async () => Buffer.from(command instanceof GetObjectCommand && command.input.Bucket === 'customer-private' ? 'bad' : 'abc') }, ContentLength: 3 }));
  await requestMediaMigration('org'); await runMediaMigrationBatch('org');
  expect((await getStore().getDoc<any>(mediaPath)).storage.provider).toBe('draft_r2');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'failed', copied_files: 0 });
});

it('rewrites branch references without overwriting a concurrent content edit', async () => {
  const store = getStore();
  await store.setDoc(paths.version('org', 'site', 'design'), { kind: 'branch' });
  const page = `${paths.pages('org', 'site', 'design')}/home`;
  await store.setDoc(page, { html_content: '<img src="https://old.example.com/a.png">', title: 'Initial' });
  const compare = store.compareAndUpdateDoc.bind(store);
  vi.spyOn(store, 'compareAndUpdateDoc').mockImplementation(async (path, predicate, patch) => {
    if (path === page) await store.updateDoc(page, { title: 'Concurrent edit' });
    return compare(path, predicate, patch);
  });
  const replacements = new Map([['https://old.example.com/a.png', oldUrl]]);
  expect(await rewriteMediaReferences('org', 'site', replacements)).toBe(false);
  expect(await store.getDoc<any>(page)).toMatchObject({ title: 'Concurrent edit', html_content: expect.stringContaining('old.example.com') });
  vi.restoreAllMocks();
  expect(await rewriteMediaReferences('org', 'site', replacements)).toBe(true);
  expect(await store.getDoc<any>(page)).toMatchObject({ title: 'Concurrent edit', html_content: expect.stringContaining(oldUrl) });
});

it('keeps a stable organization alias when a site gets its own media host and legacy path', async () => {
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, sha256: sha, public_path: '/wp-content/uploads/2023/photo.png', storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: `private/media/abcdefghij/originals/${sha}/image.png`, state: 'ready' } });
  const config = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: config.revision, website_host: 'www.example.com', media_host: 'images.example.com', media_path_prefix: '', dns_mode: 'external' });
  const result = await publicationMediaManifest('org', 'site', { html_content: `<img src="${oldUrl}?size=large#image">` }, 'www.example.com');
  expect(result.content.html_content).toBe('<img src="https://images.example.com/wp-content/uploads/2023/photo.png?size=large#image">');
  expect(result.manifest?.entries[0].aliases).toContainEqual({ url: 'https://media.example.net/media/abcdefghij/wp-content/uploads/2023/photo.png', key: 'media/abcdefghij/wp-content/uploads/2023/photo.png' });
  expect(JSON.stringify(result.manifest)).not.toMatch(/synthetic-key|secret_access_key|X-Amz/);
});

it('packages media on the website origin and preserves shared aliases and frozen paths after CMS metadata is removed', async () => {
  const mediaPath = `${paths.media('org', 'site')}/image`;
  await getStore().setDoc(mediaPath, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl,
    sha256: sha, public_path: '/archive/photo.png', storage: { provider: 'organization_r2',
      account_id: 'a'.repeat(32), bucket: 'customer-private', key: `private/media/abcdefghij/originals/${sha}/image.png`, state: 'ready' } });
  const first = await publicationMediaManifest('org', 'site', { html_content: `<img src="${oldUrl}">` }, 'site.demos.example.com');
  const organizationUrl = 'https://media.example.net/media/abcdefghij/archive/photo.png';
  expect(first.manifest?.media_host).toBe('site.demos.example.com');
  expect(first.manifest?.media_path_prefix).toBe('/media');
  expect(first.manifest?.entries[0].aliases).toContainEqual({ url: organizationUrl, key: 'media/abcdefghij/archive/photo.png' });
  expect(first.content.html_content).toBe('<img src="https://site.demos.example.com/media/archive/photo.png">');
  const config = await getSiteDomains('org', 'site');
  await saveSiteDomains('org', 'site', { revision: config.revision, website_host: 'www.example.com',
    media_host: 'images.example.com', media_path_prefix: '', dns_mode: 'external' });
  await getStore().deleteDoc(mediaPath);
  const { canReplaceOrganizationMediaHost } = await import('../../lib/publishing/domain-config');
  expect(await canReplaceOrganizationMediaHost('org', await getOrganizationDomains('org'))).toBe(false);
  const next = await publicationMediaManifest('org', 'site', first.content, 'www.example.com',
    { site_url: 'https://site.demos.example.com', media_manifest: first.manifest });
  expect(next.content.html_content).toBe('<img src="https://images.example.com/archive/photo.png">');
  expect(next.manifest?.entries[0].aliases).toContainEqual({ url: organizationUrl, key: 'media/abcdefghij/archive/photo.png' });
  expect(next.manifest?.entries[0].source_key).toBe(first.manifest?.entries[0].source_key);
});


it('completes empty organizations immediately without a worker, storage calls or media DNS', async () => {
  const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('Storage must not be called'));
  vi.mocked(preparePublicMediaDomains).mockRejectedValue(new Error('Domain is not configured'));
  await requestMediaMigration('org');
  const migration = (await getStore().listDocs<any>('publishing_media_migrations'))[0];
  expect(migration).toMatchObject({ state: 'complete', pending_files: 0, copied_files: 0, error: null });
  await runMediaMigrationBatch('org');
  expect(send).not.toHaveBeenCalled();
  expect(preparePublicMediaDomains).not.toHaveBeenCalled();
});

it.each(['queued', 'running', 'failed'])('recovers an empty %s migration on status refresh', async state => {
  const store = getStore();
  const migration = (await store.listDocs<any>('publishing_media_migrations'))[0];
  await store.updateDoc(`publishing_media_migrations/${migration.id}`, {
    state, lease_id: 'expired-worker', lease_until: 1, pending_files: 0, error: 'Old domain setup failure',
  });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', pending_files: 0, copied_files: 0, error: null });
});

it('does not clear a live worker lease or mistake unscanned uploads for an empty library', async () => {
  const store = getStore();
  const migration = (await store.listDocs<any>('publishing_media_migrations'))[0];
  const path = `publishing_media_migrations/${migration.id}`;
  await store.updateDoc(path, { state: 'running', lease_id: 'active', lease_until: Date.now() + 120_000 });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'running' });
  await store.updateDoc(path, { state: 'queued', lease_id: null, lease_until: 0 });
  await store.setDoc(`${paths.media('org', 'site')}/late-upload`, { r2_key: 'upload', storage: { provider: 'draft_r2', state: 'uploading' } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued', pending_files: 0 });
});

it('requeues a late source upload after an empty migration was completed', async () => {
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete' });
  await getStore().setDoc(`${paths.media('org', 'site')}/late-upload`, { r2_key: 'upload', storage: { provider: 'draft_r2', state: 'ready' } });
  await requestMediaMigration('org');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued' });
});

it('preserves a new migration request made during the empty scan', async () => {
  const store = getStore();
  const migration = (await store.listDocs<any>('publishing_media_migrations'))[0];
  const path = `publishing_media_migrations/${migration.id}`;
  await store.updateDoc(path, { state: 'queued', request_id: 'old-request' });
  const compare = store.compareAndUpdateDoc.bind(store);
  vi.spyOn(store, 'compareAndUpdateDoc').mockImplementation(async (target, predicate, patch) => {
    if (target === path) await store.updateDoc(path, { request_id: 'new-request' });
    return compare(target, predicate, patch);
  });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued' });
  expect(await store.getDoc<any>(path)).toMatchObject({ request_id: 'new-request', state: 'queued' });
});

it('adopts existing sites when organization media migration is requested, including empty libraries', async () => {
  await getStore().setDoc(paths.site('org', 'legacy'), {
    name: 'Legacy site', publishing_mode: 'managed', domain: 'www.example.com',
    hosting_config: { pages_project: 'existing-live-project' },
  });
  await requestMediaMigration('org');
  expect(await getStore().getDoc(paths.site('org', 'legacy'))).toMatchObject({
    publishing_mode: 'customer_git', domain: 'www.example.com',
    hosting_config: { pages_project: 'existing-live-project' },
  });
  expect((await getSiteDomains('org', 'legacy')).desired.website_host).toBe('www.example.com');
  expect((await mediaMigrationStatus('org'))?.state).toBe('complete');
});
