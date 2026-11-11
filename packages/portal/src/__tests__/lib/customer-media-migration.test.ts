import { copyWithTransferService } from '../../lib/media/remote-transfer';
import { ConnectionError } from '../../lib/publishing/connections';
vi.mock('../../lib/media/remote-transfer', () => ({ copyWithTransferService: vi.fn() }));
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, CopyObjectCommand } from '../../lib/net/s3';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getSiteDomains, saveSiteDomains, getOrganizationDomains, saveOrganizationDomains, organizationDomainConfigPath } from '../../lib/publishing/domain-config';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { requestMediaMigration, requestOrganizationMediaMigration, retryMediaMigration, runMediaMigrationBatch, executeMediaMigration, mediaMigrationStatus, rewriteMediaReferences } from '../../lib/publishing/media-migration';
import { preparePublicMediaDomains } from '../../lib/publishing/media-domain';
import { publicationMediaManifest } from '../../lib/publishing/media-manifest';
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));
vi.mock('../../lib/publishing/media-domain', () => ({ preparePublicMediaDomains: vi.fn(async () => true) }));
const sha = createHash('sha256').update('abc').digest('hex');
const oldUrl = 'https://cms.example.com/api/sites/site/media/image/content';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.mocked(copyWithTransferService).mockReset().mockResolvedValue({ protocol: 1, id: "00000000-0000-0000-0000-000000000000", sha256: sha, size: 3, etag: '"verified"' });
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
  await saveOrganizationDomains('org', { revision: config.revision, sites_domain: 'demos.example.com', media_host: 'media.example.net', dns_mode: 'external' }, { prepareMediaDomain: false });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('verifies bytes before switching storage and preserves an edit made while copying', async () => {
  const mediaPath = `${paths.media('org', 'site')}/image`;
  await getStore().setDoc(mediaPath, { filename: 'image.png', mime_type: 'image/png', alt_text: 'Before copy', cdn_url: oldUrl, r2_key: 'original', sha256: sha,
    storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: 'original', state: 'ready', generation: 'draft' } });
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
    if (command instanceof CopyObjectCommand) {
      expect((await getStore().getDoc<any>(mediaPath)).storage.provider).toBe('draft_r2');
      await getStore().updateDoc(mediaPath, { alt_text: 'Edited during copy' });
    }
    return { Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3 };
  });
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(0);
  expect(await getStore().getDoc<any>(mediaPath)).toMatchObject({ alt_text: 'Edited during copy', storage: { provider: 'organization_r2', state: 'ready' }, sha256: sha, migration_source: { key: 'original' } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 1, copied_bytes: 3 });
});

it('does not switch an original whose destination fails byte verification', async () => {
  const mediaPath = `${paths.media('org', 'site')}/image`;
  await getStore().setDoc(mediaPath, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, r2_key: 'original', sha256: sha,
    storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: 'original', state: 'ready', generation: 'draft' } });
  vi.mocked(copyWithTransferService).mockRejectedValue(new ConnectionError('The copied file does not match the original.', 422, 'media_integrity_failed'));
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  expect((await getStore().getDoc<any>(mediaPath)).storage.provider).toBe('draft_r2');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete_with_failures', ok: false, copied_files: 0, failed_files: 1,
    failed_media: [{ site_id: 'site', media_id: 'image', code: 'media_integrity_failed', transient: false }], failed_media_total: 1, failed_media_next: null });
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

it('serves media from the organization media host and preserves shared aliases and frozen paths after CMS metadata is removed', async () => {
  const mediaPath = `${paths.media('org', 'site')}/image`;
  await getStore().setDoc(mediaPath, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl,
    sha256: sha, public_path: '/archive/photo.png', storage: { provider: 'organization_r2',
      account_id: 'a'.repeat(32), bucket: 'customer-private', key: `private/media/abcdefghij/originals/${sha}/image.png`, state: 'ready' } });
  const first = await publicationMediaManifest('org', 'site', { html_content: `<img src="${oldUrl}">` }, 'site.demos.example.com');
  const organizationUrl = 'https://media.example.net/media/abcdefghij/archive/photo.png';
  expect(first.manifest).toMatchObject({ delivery: 'r2', media_host: 'media.example.net', media_path_prefix: '/media/abcdefghij' });
  expect(first.manifest?.entries[0].aliases).toContainEqual({ url: organizationUrl, key: 'media/abcdefghij/archive/photo.png' });
  expect(first.content.html_content).toBe(`<img src="${organizationUrl}">`);
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


it('keeps media on the website when the organization has no media host', async () => {
  await getStore().setDoc(organizationDomainConfigPath('org'), { ...(await getOrganizationDomains('org')), media_host: null });
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, sha256: sha,
    public_path: '/archive/photo.png', storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: `private/media/abcdefghij/originals/${sha}/image.png`, state: 'ready' } });
  const result = await publicationMediaManifest('org', 'site', { html_content: `<img src="${oldUrl}">` }, 'site.demos.example.com');
  expect(result.manifest).toMatchObject({ delivery: 'static', media_host: 'site.demos.example.com', media_path_prefix: '/media' });
  expect(result.content.html_content).toBe('<img src="https://site.demos.example.com/media/archive/photo.png">');
});

it('serves media from a site media host through the organization bucket', async () => {
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, sha256: sha,
    public_path: '/archive/photo.png', storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: `private/media/abcdefghij/originals/${sha}/image.png`, state: 'ready' } });
  const saved = await getSiteDomains('org', 'site');
  const domains = { ...saved, desired: { website_host: 'www.customer.com', media_host: 'media.customer.com', media_path_prefix: '' } };
  const result = await publicationMediaManifest('org', 'site', { html_content: `<img src="${oldUrl}">` }, 'www.customer.com', undefined, { domains });
  expect(result.manifest).toMatchObject({ delivery: 'r2', media_host: 'media.customer.com', media_path_prefix: '' });
  expect(result.manifest!.entries[0]).toMatchObject({ public_key: 'media/abcdefghij/archive/photo.png' });
  expect(result.content.html_content).toBe('<img src="https://media.customer.com/archive/photo.png">');
});

it('marks media that a page shares so the build can prepare its share copy without the pages', async () => {
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, sha256: sha,
    public_path: '/archive/photo.png', storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: `private/media/abcdefghij/originals/${sha}/image.png`, state: 'ready' } });
  const shared = await publicationMediaManifest('org', 'site', { pages: [{ id: 'p', og_image: oldUrl }] }, 'site.demos.example.com');
  expect(shared.manifest!.entries[0]).toMatchObject({ share_source: true });
  const body = await publicationMediaManifest('org', 'site', { pages: [{ id: 'p', html_content: `<img src="${oldUrl}">` }] }, 'site.demos.example.com');
  expect(body.manifest!.entries[0].share_source).toBeUndefined();
});

it('completes empty organizations immediately without a worker, storage calls or media DNS', async () => {
  const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('Storage must not be called'));
  vi.mocked(preparePublicMediaDomains).mockRejectedValue(new Error('Domain is not configured'));
  await requestMediaMigration('org', 'site');
  const migration = (await getStore().listDocs<any>('publishing_media_migrations'))[0];
  expect(migration).toMatchObject({ state: 'complete', pending_files: 0, copied_files: 0, error: null });
  await runMediaMigrationBatch('org', 'site');
  expect(send).not.toHaveBeenCalled();
  expect(preparePublicMediaDomains).not.toHaveBeenCalled();
});

it.each(['queued', 'running', 'failed'])('recovers an empty %s migration on status refresh', async state => {
  const store = getStore();
  await requestMediaMigration('org', 'site');
  const migration = (await store.listDocs<any>('publishing_media_migrations'))[0];
  await store.updateDoc(`publishing_media_migrations/${migration.id}`, {
    state, lease_id: 'expired-worker', lease_until: 1, pending_files: 0, error: 'Old domain setup failure',
  });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', pending_files: 0, copied_files: 0, error: null });
});

it('does not clear a live worker lease or mistake unscanned uploads for an empty library', async () => {
  const store = getStore();
  await requestMediaMigration('org', 'site');
  const migration = (await store.listDocs<any>('publishing_media_migrations'))[0];
  const path = `publishing_media_migrations/${migration.id}`;
  await store.updateDoc(path, { state: 'running', lease_id: 'active', lease_until: Date.now() + 120_000 });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'running' });
  await store.updateDoc(path, { state: 'queued', lease_id: null, lease_until: 0 });
  await store.setDoc(`${paths.media('org', 'site')}/late-upload`, { r2_key: 'upload', storage: { provider: 'draft_r2', state: 'uploading' } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued', pending_files: 0 });
});

it('requeues a late source upload after an empty migration was completed', async () => {
  await requestMediaMigration('org', 'site');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete' });
  await getStore().setDoc(`${paths.media('org', 'site')}/late-upload`, { r2_key: 'upload', storage: { provider: 'draft_r2', state: 'ready' } });
  await requestMediaMigration('org', 'site');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued' });
});

it('preserves a new migration request made during the empty scan', async () => {
  const store = getStore();
  await requestMediaMigration('org', 'site');
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

it('migrates the media of a site with the former managed mode like any customer-published site, without changing the site', async () => {
  await getStore().setDoc(paths.site('org', 'legacy'), {
    name: 'Legacy site', publishing_mode: 'managed', domain: 'www.example.com',
    hosting_config: { pages_project: 'existing-live-project' },
  });
  const { usesPrivateMedia } = await import('../../lib/publishing/media-policy');
  expect(await usesPrivateMedia('org', (await getStore().getDoc<any>(paths.site('org', 'legacy'))))).toBe(true);
  await requestOrganizationMediaMigration('org'); await executeMediaMigration('org');
  expect(await getStore().getDoc(paths.site('org', 'legacy'))).toMatchObject({
    publishing_mode: 'managed', domain: 'www.example.com',
    hosting_config: { pages_project: 'existing-live-project' },
  });
  expect((await getSiteDomains('org', 'legacy')).desired.website_host).toBeNull();
});

const fixtureMedia = (id: string) => ({ filename: `${id}.png`, mime_type: 'image/png', cdn_url: `https://old.example.com/${id}.png`, r2_key: id, sha256: sha,
  storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: id, state: 'ready', generation: 'draft' } });
const goodBody = () => ({ Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3 });

it('dispatches media work immediately instead of waiting for a scheduled publication sweep', async () => {
  const { enqueueMediaMigration } = await import('../../lib/publishing/media-migration-queue');
  vi.mocked(enqueueMediaMigration).mockClear();
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  await requestMediaMigration('org', 'site');
  expect(enqueueMediaMigration).toHaveBeenCalledExactlyOnceWith('org', 0, 'site');
});

it('migrates 1,001 originals in consecutive bounded tasks with linear reads and a single reference rewrite', async () => {
  const store = getStore(); const mediaPath = paths.media('org', 'site');
  for (let index = 0; index < 1001; index++) {
    const id = `image-${String(index).padStart(4, '0')}`;
    await store.setDoc(`${mediaPath}/${id}`, fixtureMedia(id));
  }
  const page = `${paths.pages('org', 'site', 'main')}/home`;
  await store.setDoc(page, { html_content: '<img src="https://old.example.com/image-1000.png">' });
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  const list = vi.spyOn(store, 'listDocs');
  const writes = vi.spyOn(store, 'compareAndUpdateDoc');
  await requestMediaMigration('org', 'site');
  const { executeMediaMigration } = await import('../../lib/publishing/media-migration');
  for (let batch = 0; batch < 11; batch++) {
    const delay = await executeMediaMigration('org', 'site');
    // After the copy pass the migration requests image preparation, which
    // starts at once; without a configured engine it waits for setup and the
    // recovery poll resumes it.
    expect(delay).toBe(batch === 10 ? null : 0);
    expect((await mediaMigrationStatus('org'))?.copied_files).toBe(Math.min((batch + 1) * 100, 1001));
  }
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 1001, copied_bytes: 3003 });
  expect((await store.getDoc<any>(page)).html_content).toContain('/media/image-1000/content');
  expect(writes.mock.calls.filter(([path]) => path === page)).toHaveLength(1);
  const pages = list.mock.calls.filter(([path, opts]) => path === mediaPath && opts?.startAfterId !== undefined);
  expect(pages).toHaveLength(12);
  expect(new Set(pages.map(([, opts]) => opts!.startAfterId)).size).toBe(12);
  expect(list.mock.calls.filter(([path, opts]) => path === mediaPath && !opts)).toHaveLength(1);
}, 30_000);

it('rescans a late upload before the cursor even when it arrives between tasks', async () => {
  const store = getStore(); const mediaPath = paths.media('org', 'site');
  await store.setDoc(`${mediaPath}/z`, fixtureMedia('z'));
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site', 1);
  await store.setDoc(`${mediaPath}/a`, fixtureMedia('a'));
  await requestMediaMigration('org', 'site');
  await runMediaMigrationBatch('org', 'site');
  expect((await mediaMigrationStatus('org'))?.state).toBe('queued');
  await runMediaMigrationBatch('org', 'site');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 2, copied_bytes: 6 });
  expect((await store.getDoc<any>(`${mediaPath}/a`)).storage.provider).toBe('organization_r2');
});

it('recovers a crash after the copy was saved but before its cursor, without recopying or double counting', async () => {
  const store = getStore(); const mediaPath = `${paths.media('org', 'site')}/image`;
  await store.setDoc(mediaPath, fixtureMedia('image'));
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  await requestMediaMigration('org', 'site');
  const compare = store.compareAndUpdateDoc.bind(store);
  let crashed = false;
  vi.spyOn(store, 'compareAndUpdateDoc').mockImplementation(async (path, check, patch) => {
    if (!crashed && patch.cursor?.media === 'image') { crashed = true; throw new Error('process interrupted'); }
    return compare(path, check, patch);
  });
  await runMediaMigrationBatch('org', 'site');
  const job = (await store.listDocs<any>('publishing_media_migrations'))[0];
  expect(job).toMatchObject({ state: 'queued', copied_files: 0, cursor: { media: '' } });
  await store.updateDoc(`publishing_media_migrations/${job.id}`, { retry_at: 0 });
  await runMediaMigrationBatch('org', 'site');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 1, copied_bytes: 3 });
  expect(send.mock.calls.filter(([command]) => command instanceof CopyObjectCommand)).toHaveLength(1);
  expect(copyWithTransferService).toHaveBeenCalledTimes(1);
});

it('retries an interrupted transfer automatically and pauses after three unsuccessful attempts', async () => {
  const store = getStore();
  await store.setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('temporary unavailable'));
  await requestMediaMigration('org', 'site');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = (await store.listDocs<any>('publishing_media_migrations'))[0];
    await store.updateDoc(`publishing_media_migrations/${job.id}`, { retry_at: 0 });
    await runMediaMigrationBatch('org', 'site');
    expect((await mediaMigrationStatus('org'))?.state).toBe(attempt === 3 ? 'complete_with_failures' : 'queued');
  }
  // The third attempt sets the file aside with its own reason instead of blaming R2 access.
  const status = await mediaMigrationStatus('org');
  expect(status?.error).toContain('1 file could not be copied');
  expect(status).toMatchObject({ failed_files: 1, ok: false, updated_at: expect.any(String),
    sites: [{ site_id: 'site', state: 'complete_with_failures', ok: false, failed_files: 1 }], failed_media: [{ media_id: 'image', code: 'media_transfer_interrupted' }] });
});

it('lets only one worker copy while a duplicate delivery observes the active lease', async () => {
  const store = getStore();
  await store.setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  let duplicateChecked = false;
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => {
    if (!duplicateChecked) {
      duplicateChecked = true;
      const { executeMediaMigration } = await import('../../lib/publishing/media-migration');
      expect(await executeMediaMigration('org', 'site')).toBeGreaterThan(0);
    }
    return goodBody();
  });
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  expect(send.mock.calls.filter(([command]) => command instanceof CopyObjectCommand)).toHaveLength(1);
  expect(copyWithTransferService).toHaveBeenCalledTimes(1);
  expect((await mediaMigrationStatus('org'))?.state).toBe('complete');
});


it('rejects a private media identity that cannot be resolved in this site before producing public source', async () => {
  await expect(publicationMediaManifest('org', 'site', { pages: [{ blocks: [{ type: 'core/image', data: { src: oldUrl } }] }] }, 'site.demos.example.com'))
    .rejects.toMatchObject({ status: 409, code: 'media_reference_unresolved', message: expect.stringContaining('image') });
});
it('rewrites image, srcset, background and download references without exposing private URLs', async () => {
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, sha256: sha,
    storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: 'private/image.png', state: 'ready' } });
  const content = { html: `<img src="${oldUrl}" srcset="${oldUrl} 640w"><a href="${oldUrl}">Download</a>`, css: `background-image:url('${oldUrl}')` };
  const result = await publicationMediaManifest('org', 'site', content, 'site.demos.example.com');
  expect(JSON.stringify(result.content)).not.toContain('/api/sites/');
  expect(result.content.html.match(/media\.example\.net\/media\/abcdefghij\//g)).toHaveLength(3);
  expect(result.content.css).toContain('https://media.example.net/media/abcdefghij/');
  expect(content.html).toContain(oldUrl);
});

it('resolves deferred media in the builder and keeps aliases across domain-only preparation', async () => {
  const { resolvePublicationReferences } = await import('../../../../../scripts/fixtures/static-publication/references.mjs');
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, sha256: sha,
    storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: 'original', state: 'ready' } });
  const source = { site_url: 'https://first.example.com', pages: [{ html: `<img src="${oldUrl}?width=400">` }] };
  const first = await publicationMediaManifest('org', 'site', source, 'first.example.com', undefined, { deferReferences: true });
  expect(first.content.pages).toEqual(source.pages);
  const frozen = { ...first.content, media_manifest: first.manifest, media: first.media };
  expect(resolvePublicationReferences(frozen).pages[0].html).toContain(first.media[0].cdn_url);
  await getStore().deleteDoc(`${paths.media('org', 'site')}/image`);
  const next = await publicationMediaManifest('org', 'site', frozen, 'next.example.com', frozen, { deferReferences: true });
  const ready = resolvePublicationReferences({ ...next.content, site_url: 'https://next.example.com', media_manifest: next.manifest, media: next.media });
  // A website-only change keeps images on the organization media host.
  expect(ready.pages[0].html).toContain('https://media.example.net/media/abcdefghij/');
  expect(ready.pages[0].html).not.toContain('/api/sites/');
});

it('does not accept an unresolved private URL merely because a matching media ID is mapped', async () => {
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, sha256: sha,
    storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: 'original', state: 'ready' } });
  const source = { pages: [{ html: `${oldUrl} https://wrong.example/api/sites/site/media/image/content` }] };
  await expect(publicationMediaManifest('org', 'site', source, 'site.example', undefined, { deferReferences: true })).rejects.toMatchObject({ code: 'media_reference_unresolved' });
});

it('migrates only the requesting site and queues no work for its neighbours', async () => {
  const store = getStore();
  await store.setDoc(paths.site('org', 'neighbour'), { media_id: 'klmnopqrst', publishing_mode: 'customer_git' });
  await store.setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  await store.setDoc(`${paths.media('org', 'neighbour')}/other`, fixtureMedia('other'));
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  const { enqueueMediaMigration } = await import('../../lib/publishing/media-migration-queue');
  vi.mocked(enqueueMediaMigration).mockClear();
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  expect(vi.mocked(enqueueMediaMigration).mock.calls.filter(([, , site]) => site !== undefined)).toEqual([['org', 0, 'site']]);
  expect((await store.getDoc<any>(`${paths.media('org', 'site')}/image`)).storage.provider).toBe('organization_r2');
  expect((await store.getDoc<any>(`${paths.media('org', 'neighbour')}/other`)).storage.provider).toBe('draft_r2');
  expect((await store.listDocs<any>('publishing_media_migrations')).map(job => job.site_id)).toEqual(['site']);
  expect((await store.listDocs<any>('media_preparations')).map(job => job.site)).toEqual(['site']);
});

it('finishes a site whose files are already in place without queuing a preparation build', async () => {
  const store = getStore();
  await store.setDoc(`${paths.media('org', 'site')}/image`, { filename: 'image.png', mime_type: 'image/png', cdn_url: oldUrl, r2_key: 'k', sha256: sha,
    storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: 'k', state: 'ready', generation: 'connected' } });
  const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('Storage must not be called'));
  await requestOrganizationMediaMigration('org'); await executeMediaMigration('org'); await runMediaMigrationBatch('org', 'site');
  expect(send).not.toHaveBeenCalled();
  expect(await store.listDocs<any>('media_preparations')).toEqual([]);
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 0 });
});

it('prepares the media domain in the organization job, not in site jobs', async () => {
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  expect(preparePublicMediaDomains).not.toHaveBeenCalled();
  await requestOrganizationMediaMigration('org'); await executeMediaMigration('org');
  expect(preparePublicMediaDomains).toHaveBeenCalledOnce();
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued' });
  await runMediaMigrationBatch('org', 'site');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 1 });
});

it('hands an organization-wide request queued before site jobs to each site', async () => {
  const store = getStore();
  await store.setDoc(paths.site('org', 'neighbour'), { media_id: 'klmnopqrst', publishing_mode: 'customer_git' });
  await store.setDoc(`${paths.media('org', 'neighbour')}/other`, fixtureMedia('other'));
  const legacy = `publishing_media_migrations/${createHash('sha256').update('org').digest('hex')}`;
  await store.setDoc(legacy, { org_id: 'org', state: 'queued', copied_files: 5, copied_bytes: 15, pending_files: 0, lease_id: null, lease_until: 0, request_id: 'old' });
  await executeMediaMigration('org');
  expect(await store.getDoc<any>(legacy)).toMatchObject({ scope: 'organization', state: 'complete' });
  expect((await store.listDocs<any>('publishing_media_migrations')).filter(job => job.scope === 'site').map(job => [job.site_id, job.state]).sort())
    .toEqual([['neighbour', 'queued'], ['site', 'complete']]);
});

it('gives every site its own job in the background and resumes after the time budget', async () => {
  const store = getStore();
  for (const id of ['a-site', 'b-site', 'c-site']) {
    await store.setDoc(paths.site('org', id), { media_id: `${id}-media`.padEnd(10, 'x'), publishing_mode: 'customer_git' });
    await store.setDoc(`${paths.media('org', id)}/image`, fixtureMedia('image'));
  }
  const siteJobs = async () => (await store.listDocs<any>('publishing_media_migrations')).filter(job => job.scope === 'site').map(job => job.site_id).sort();
  await requestOrganizationMediaMigration('org');
  expect(await siteJobs()).toEqual([]);
  const now = Date.now(); let tick = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now + (tick++ > 6 ? 60_000 : 0));
  await executeMediaMigration('org');
  vi.mocked(Date.now).mockRestore();
  const partial = await siteJobs();
  expect(partial.length).toBeGreaterThan(0); expect(partial.length).toBeLessThan(4);
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued' });
  await executeMediaMigration('org');
  expect(await siteJobs()).toEqual(['a-site', 'b-site', 'c-site', 'site']);
  expect(preparePublicMediaDomains).toHaveBeenCalledOnce();
});

it('starts no site work when organization domains change, and prepares only a new media host', async () => {
  const store = getStore();
  await store.setDoc(paths.site('org', 'neighbour'), { media_id: 'klmnopqrst', publishing_mode: 'customer_git' });
  await store.setDoc(`${paths.media('org', 'neighbour')}/other`, fixtureMedia('other'));
  const { enqueueMediaMigration } = await import('../../lib/publishing/media-migration-queue');
  vi.mocked(enqueueMediaMigration).mockClear();
  let config = await getOrganizationDomains('org');
  await saveOrganizationDomains('org', { revision: config.revision, sites_domain: 'sites.example.com', media_host: 'media.example.net', dns_mode: 'external' });
  expect(enqueueMediaMigration).not.toHaveBeenCalled();
  // An organization that had no media host yet adds one.
  await store.updateDoc(organizationDomainConfigPath('org'), { media_host: null, default_domain: null });
  expect(await store.listDocs<any>('publishing_media_migrations')).toEqual([]);
  config = await getOrganizationDomains('org');
  await saveOrganizationDomains('org', { revision: config.revision, sites_domain: 'sites.example.com', media_host: 'files.example.net', dns_mode: 'external' });
  expect(vi.mocked(enqueueMediaMigration).mock.calls).toEqual([['org']]);
  await executeMediaMigration('org');
  expect(preparePublicMediaDomains).toHaveBeenCalledWith('org', expect.objectContaining({ media_host: 'files.example.net' }));
  expect((await store.listDocs<any>('publishing_media_migrations')).map(job => [job.scope, job.state])).toEqual([['organization', 'complete']]);
});

it('does not repeat a finished pre-site-job pass when only the media host changes', async () => {
  const store = getStore();
  const legacy = `publishing_media_migrations/${createHash('sha256').update('org').digest('hex')}`;
  await store.setDoc(legacy, { org_id: 'org', state: 'complete', copied_files: 5, copied_bytes: 15, pending_files: 0, lease_id: null, lease_until: 0, request_id: 'old' });
  const config = await getOrganizationDomains('org');
  await saveOrganizationDomains('org', { revision: config.revision, sites_domain: 'demos.example.com', media_host: 'files.example.net', dns_mode: 'external' });
  await executeMediaMigration('org');
  expect((await store.listDocs<any>('publishing_media_migrations')).filter(job => job.scope === 'site')).toEqual([]);
  expect(await store.getDoc<any>(legacy)).toMatchObject({ scope: 'organization', state: 'complete' });
});

it('retries only failed or abandoned site jobs and reads no other site', async () => {
  const store = getStore();
  for (const id of ['done', 'failed', 'stalled', 'untouched']) await store.setDoc(paths.site('org', id), { media_id: `${id}-media`.padEnd(10, 'x'), publishing_mode: 'customer_git' });
  const job = (id: string) => `publishing_media_migrations/${createHash('sha256').update(`org\0${id}`).digest('hex')}`;
  const base = { org_id: 'org', scope: 'site', copied_files: 0, copied_bytes: 0, pending_files: 0, lease_id: null, lease_until: 0 };
  await store.setDoc(job('done'), { ...base, site_id: 'done', state: 'complete', request_id: 'done' });
  await store.setDoc(job('failed'), { ...base, site_id: 'failed', state: 'failed', error: 'Access denied', failures: 3, request_id: 'failed' });
  await store.setDoc(`${paths.media('org', 'failed')}/image`, fixtureMedia('image'));
  await store.setDoc(job('stalled'), { ...base, site_id: 'stalled', state: 'queued', request_id: 'stalled' });
  await store.setDoc(`${paths.media('org', 'stalled')}/image`, fixtureMedia('image'));
  const { enqueueMediaMigration } = await import('../../lib/publishing/media-migration-queue');
  vi.mocked(enqueueMediaMigration).mockClear();
  await retryMediaMigration('org');
  expect(vi.mocked(enqueueMediaMigration).mock.calls.map(([, , site]) => site).sort()).toEqual(['failed', 'stalled']);
  expect(await store.getDoc<any>(job('failed'))).toMatchObject({ state: 'queued', error: null, failures: 0 });
  expect(await store.getDoc<any>(job('done'))).toMatchObject({ state: 'complete', request_id: 'done' });
  expect(await store.getDoc<any>(job('untouched'))).toBeNull();
});

it('sets aside a source the transfer service refuses, finishes the rest, and retries it only on request', async () => {
  const store = getStore();
  await store.setDoc(`${paths.media('org', 'site')}/dead`, { ...fixtureMedia('dead'), filename: 'q.jpg' });
  await store.setDoc(`${paths.media('org', 'site')}/good`, fixtureMedia('good'));
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  let refuse = true;
  vi.mocked(copyWithTransferService).mockImplementation(async input => {
    if (input.sourceUrl.includes('/dead?') && refuse) throw new ConnectionError('The original file could not be downloaded.', 422, 'media_source_unavailable');
    return { protocol: 1, id: '00000000-0000-0000-0000-000000000000', sha256: sha, size: 3, etag: '"verified"' } as any;
  });
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  const status = await mediaMigrationStatus('org');
  // Set-aside files are listed with their reason; they do not leave the migration failed (FI-10).
  expect(status).toMatchObject({ state: 'complete_with_failures', ok: false, failed_files: 1, copied_files: 1, failed_media: [{ media_id: 'dead', filename: 'q.jpg', code: 'media_source_unavailable', message: 'The original file could not be downloaded.' }] });
  expect(status?.error).toContain('1 file could not be copied');
  // A later upload on the Site does not retry the refused file.
  const { enqueueMediaMigration } = await import('../../lib/publishing/media-migration-queue');
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  expect(vi.mocked(copyWithTransferService)).toHaveBeenCalledTimes(2);
  refuse = false;
  vi.mocked(enqueueMediaMigration).mockClear();
  await retryMediaMigration('org');
  expect(vi.mocked(enqueueMediaMigration).mock.calls).toEqual([['org', 0, 'site']]);
  expect(await store.getDoc<any>(`${paths.media('org', 'site')}/dead`)).toMatchObject({ migration_failed: false, migration_error: null });
  await runMediaMigrationBatch('org', 'site');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', ok: true, failed_files: 0, copied_files: 2, failed_media: [] });
});

it('hands a failed organization-wide request from before site jobs to every site on retry', async () => {
  const store = getStore();
  const legacy = `publishing_media_migrations/${createHash('sha256').update('org').digest('hex')}`;
  await store.setDoc(legacy, { org_id: 'org', state: 'failed', copied_files: 5, copied_bytes: 15, pending_files: 18, lease_id: null, lease_until: 0, request_id: 'old', failures: 3,
    error: 'Media migration paused after three attempts. Check R2 access in Publishing and retry.' });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'failed', updated_at: null });
  await retryMediaMigration('org');
  await executeMediaMigration('org');
  expect(await store.getDoc<any>(legacy)).toMatchObject({ scope: 'organization', state: 'complete' });
  expect((await store.listDocs<any>('publishing_media_migrations')).filter(job => job.scope === 'site').map(job => job.site_id)).toEqual(['site']);
});

const pendingImport = (id: string, extra: Record<string, unknown> = {}) => ({ filename: `${id}.png`, mime_type: 'image/png', cdn_url: `https://cms.example.com/api/sites/site/media/${id}/content`,
  r2_key: `private/abcdefghij/uploads/${id}/${id}.png`, source_url: `https://source.example.com/${id}.png`, source_aliases: [`https://source.example.com/${id}.png`], import_pending: true,
  storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: `private/abcdefghij/uploads/${id}/${id}.png`, state: 'uploading', generation: 'connected' }, ...extra });

it('retries a pending import after 1, 5, 15, 30 and 60 minutes instead of setting it aside after three quick attempts', async () => {
  const store = getStore(), mediaPath = `${paths.media('org', 'site')}/imported`;
  await store.setDoc(mediaPath, pendingImport('imported'));
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  vi.mocked(copyWithTransferService).mockRejectedValue(new ConnectionError('The source site did not deliver the file just now.', 503, 'media_source_temporarily_unavailable'));
  await requestMediaMigration('org', 'site');
  const job = async () => (await store.listDocs<any>('publishing_media_migrations'))[0];
  for (const [index, minutes] of [1, 5, 15, 30, 60].entries()) {
    const started = Date.now();
    const delay = await executeMediaMigration('org', 'site');
    expect(copyWithTransferService).toHaveBeenCalledTimes(index + 1);
    const media = await store.getDoc<any>(mediaPath);
    expect(media).toMatchObject({ import_pending: true, import_failures: index + 1, import_error_code: 'media_source_temporarily_unavailable' });
    expect(media.migration_failed).toBeFalsy();
    const retryAt = Date.parse(media.import_retry_at);
    expect(retryAt).toBeGreaterThanOrEqual(started + minutes * 60_000);
    // The job waits for the planned retry; the chain delivers the next pass then.
    expect(await job()).toMatchObject({ state: 'queued', retry_at: retryAt, pending_files: 1 });
    expect(delay).toBeGreaterThan(minutes * 60_000 - 1_000);
    expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued', pending_files: 1, failed_files: 0, failed_media: [] });
    // A delivery before the planned time does not try the copy again.
    await store.updateDoc(`publishing_media_migrations/${(await job()).id}`, { retry_at: 0 });
    await runMediaMigrationBatch('org', 'site');
    expect(copyWithTransferService).toHaveBeenCalledTimes(index + 1);
    // Time passes until the planned retry.
    await store.updateDoc(mediaPath, { import_retry_at: new Date(Date.now() - 1).toISOString() });
    await store.updateDoc(`publishing_media_migrations/${(await job()).id}`, { retry_at: 0 });
  }
  // The last planned retry fails too: only now is the file set aside.
  expect(await executeMediaMigration('org', 'site')).toBeNull();
  expect(copyWithTransferService).toHaveBeenCalledTimes(6);
  expect(await store.getDoc<any>(mediaPath)).toMatchObject({ migration_failed: true, migration_error: { code: 'media_source_temporarily_unavailable' } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete_with_failures', ok: false, failed_files: 1,
    failed_media: [{ media_id: 'imported', code: 'media_source_temporarily_unavailable', transient: true, source_host: 'source.example.com', source_url: 'https://source.example.com/imported.png' }] });
  // A retry from Publishing starts the schedule again.
  vi.mocked(copyWithTransferService).mockResolvedValue({ protocol: 1, id: '00000000-0000-0000-0000-000000000000', sha256: sha, size: 3, etag: '"verified"' });
  await retryMediaMigration('org');
  expect(await store.getDoc<any>(mediaPath)).toMatchObject({ migration_failed: false, import_failures: 0, import_retry_at: null });
  await runMediaMigrationBatch('org', 'site');
  expect(await store.getDoc<any>(mediaPath)).toMatchObject({ import_pending: false, storage: { state: 'ready' } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', failed_files: 0, error: null });
});

it('does not report a stored file with a stale set-aside flag as skipped', async () => {
  const store = getStore(), mediaPath = `${paths.media('org', 'site')}/imported`;
  await store.setDoc(mediaPath, pendingImport('imported', { import_pending: false, sha256: sha, size_bytes: 3,
    storage: { provider: 'organization_r2', account_id: 'a'.repeat(32), bucket: 'customer-private', key: 'private/abcdefghij/originals/x/imported.png', state: 'ready', generation: 'connected' },
    migration_failed: true, migration_error: { code: 'media_transfer_unavailable', message: 'Media transfer could not finish.', at: '2026-11-08T00:00:00.000Z' } }));
  await requestMediaMigration('org', 'site');
  const [job] = await store.listDocs<any>('publishing_media_migrations');
  await store.updateDoc(`publishing_media_migrations/${job.id}`, { state: 'complete', failed_files: 1, pending_files: 0,
    error: '1 file could not be copied and was skipped. Fix or delete it, then retry media migration.' });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', failed_files: 0, error: null, failed_media: [], sites: [{ site_id: 'site', failed_files: 0, error: null }] });
  // The next pass clears the flag and counts the file as stored.
  await requestMediaMigration('org', 'site'); await runMediaMigrationBatch('org', 'site');
  expect(copyWithTransferService).not.toHaveBeenCalled();
  expect(await store.getDoc<any>(mediaPath)).toMatchObject({ migration_failed: false, migration_error: null });
  expect(await store.getDoc<any>(`publishing_media_migrations/${job.id}`)).toMatchObject({ state: 'complete', failed_files: 0, error: null });
});

it('retries a stored file stopped by the transfer Worker plan limit on the delayed schedule, then sets it aside as transient', async () => {
  const store = getStore(), mediaPath = `${paths.media('org', 'site')}/image`;
  await store.setDoc(mediaPath, fixtureMedia('image'));
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  vi.mocked(copyWithTransferService).mockRejectedValue(new ConnectionError('The Cloudflare account’s Workers plan stopped the copy.', 503, 'media_transfer_resources_exceeded'));
  await requestMediaMigration('org', 'site');
  const job = async () => (await store.listDocs<any>('publishing_media_migrations'))[0];
  for (const [index, minutes] of [1, 5, 15, 30, 60].entries()) {
    const started = Date.now();
    const delay = await executeMediaMigration('org', 'site');
    expect(copyWithTransferService).toHaveBeenCalledTimes(index + 1);
    const media = await store.getDoc<any>(mediaPath);
    expect(media).toMatchObject({ migration_failures: index + 1, storage: { provider: 'draft_r2' } });
    expect(media.migration_failed).toBeFalsy();
    expect(Date.parse(media.migration_retry_at)).toBeGreaterThanOrEqual(started + minutes * 60_000);
    // The Site waits for the planned retry instead of ending with the file skipped.
    expect(await job()).toMatchObject({ state: 'queued', pending_files: 1 });
    expect(delay).toBeGreaterThan(minutes * 60_000 - 1_000);
    expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'queued', ok: false, failed_files: 0, failed_media: [] });
    // An early delivery does not try the copy again.
    await store.updateDoc(`publishing_media_migrations/${(await job()).id}`, { retry_at: 0 });
    await runMediaMigrationBatch('org', 'site');
    expect(copyWithTransferService).toHaveBeenCalledTimes(index + 1);
    await store.updateDoc(mediaPath, { migration_retry_at: new Date(Date.now() - 1).toISOString() });
    await store.updateDoc(`publishing_media_migrations/${(await job()).id}`, { retry_at: 0 });
  }
  expect(await executeMediaMigration('org', 'site')).toBeNull();
  expect(await store.getDoc<any>(mediaPath)).toMatchObject({ migration_failed: true, migration_error: { code: 'media_transfer_resources_exceeded', transient: true } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete_with_failures', ok: false, failed_files: 1,
    sites: [{ site_id: 'site', state: 'complete_with_failures', ok: false }], failed_media: [{ media_id: 'image', code: 'media_transfer_resources_exceeded', transient: true }] });
  // A retry from Publishing starts again and a successful copy clears the schedule.
  vi.mocked(copyWithTransferService).mockResolvedValue({ protocol: 1, id: '00000000-0000-0000-0000-000000000000', sha256: sha, size: 3, etag: '"verified"' });
  await retryMediaMigration('org');
  await runMediaMigrationBatch('org', 'site');
  expect(await store.getDoc<any>(mediaPath)).toMatchObject({ migration_failed: false, migration_failures: 0, migration_retry_at: null, storage: { provider: 'organization_r2', state: 'ready' } });
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', ok: true, failed_files: 0 });
});

it('lists every set-aside file of every site with its host only, pages through them, and ignores stale counters', async () => {
  const store = getStore();
  const set = async (site: string, count: number) => {
    await store.setDoc(paths.site('org', site), { media_id: `${site}xxxxxx`.slice(0, 10), publishing_mode: 'customer_git' });
    for (let index = 0; index < count; index++) {
      const id = `${site}-${String(index).padStart(3, '0')}`;
      await store.setDoc(`${paths.media('org', site)}/${id}`, { ...fixtureMedia(id), source_url: `https://wp.example.com/uploads/${id}.png?token=secret`, migration_failed: true,
        migration_error: { code: 'media_transfer_resources_exceeded', message: `Copy of https://wp.example.com/uploads/${id}.png?token=secret stopped.`, at: '2026-11-09T00:00:00.000Z', transient: true } });
    }
  };
  await set('moveria-at', 12); await set('moveria-de', 99);
  const base = { org_id: 'org', scope: 'site', state: 'complete', copied_files: 0, copied_bytes: 0, pending_files: 0, lease_id: null, lease_until: 0 };
  // Stored counters disagree with the records: the records decide.
  await store.setDoc(`publishing_media_migrations/${createHash('sha256').update('org\0moveria-at').digest('hex')}`, { ...base, site_id: 'moveria-at', failed_files: 3 });
  await store.setDoc(`publishing_media_migrations/${createHash('sha256').update('org\0moveria-de').digest('hex')}`, { ...base, site_id: 'moveria-de', failed_files: 0 });
  // A pass over every site from before per-site jobs left its own counter behind.
  await store.setDoc(`publishing_media_migrations/${createHash('sha256').update('org').digest('hex')}`, { ...base, scope: 'organization', failed_files: 99, error: 'stale' });
  const first = (await mediaMigrationStatus('org'))!;
  expect(first).toMatchObject({ state: 'complete_with_failures', ok: false, failed_files: 111, failed_media_total: 111 });
  expect(first.error).toContain('111 files could not be copied');
  expect(first.sites).toEqual([
    expect.objectContaining({ site_id: 'moveria-at', state: 'complete_with_failures', ok: false, failed_files: 12 }),
    expect.objectContaining({ site_id: 'moveria-de', state: 'complete_with_failures', ok: false, failed_files: 99 }),
  ]);
  expect(first.failed_media).toHaveLength(100);
  expect(first.failed_media[0]).toEqual({ site_id: 'moveria-at', media_id: 'moveria-at-000', filename: 'moveria-at-000.png', source_url: 'https://wp.example.com/uploads/moveria-at-000.png',
    source_host: 'wp.example.com', code: 'media_transfer_resources_exceeded', message: 'Copy of wp.example.com stopped.', at: '2026-11-09T00:00:00.000Z', transient: true });
  expect(JSON.stringify(first)).not.toContain('token=secret');
  expect(first.failed_media_next).toBe('moveria-de/moveria-de-087');
  const second = (await mediaMigrationStatus('org', { failedAfter: first.failed_media_next }))!;
  expect(second.failed_media.map(file => file.media_id)).toEqual(Array.from({ length: 11 }, (_, index) => `moveria-de-${String(88 + index).padStart(3, '0')}`));
  expect(second.failed_media_next).toBeNull();
});
