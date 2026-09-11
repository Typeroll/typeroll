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
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));
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

it('keeps existing managed sites and their media unchanged until explicitly migrated', async () => {
  await getStore().setDoc(paths.site('org', 'legacy'), {
    name: 'Legacy site', publishing_mode: 'managed', domain: 'www.example.com',
    hosting_config: { pages_project: 'existing-live-project' },
  });
  await getStore().setDoc(`${paths.media('org', 'legacy')}/image`, { filename: 'old.png', r2_key: 'old', cdn_url: 'https://cdn.example.com/old.png' });
  const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('Legacy media must remain untouched'));
  await requestMediaMigration('org'); await runMediaMigrationBatch('org');
  expect(send).not.toHaveBeenCalled();
  expect(await getStore().getDoc(paths.site('org', 'legacy'))).toMatchObject({
    publishing_mode: 'managed', domain: 'www.example.com',
    hosting_config: { pages_project: 'existing-live-project' },
  });
  expect((await getSiteDomains('org', 'legacy')).desired.website_host).toBeNull();
  const { usesPrivateMedia } = await import('../../lib/publishing/media-policy');
  expect(await usesPrivateMedia('org', (await getStore().getDoc<any>(paths.site('org', 'legacy'))))).toBe(false);
  expect((await mediaMigrationStatus('org'))?.state).toBe('complete');
});

const fixtureMedia = (id: string) => ({ filename: `${id}.png`, mime_type: 'image/png', cdn_url: `https://old.example.com/${id}.png`, r2_key: id, sha256: sha,
  storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: id, state: 'ready', generation: 'draft' } });
const goodBody = () => ({ Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3 });

it('dispatches media work immediately instead of waiting for a scheduled publication sweep', async () => {
  const { enqueueMediaMigration } = await import('../../lib/publishing/media-migration-queue');
  vi.mocked(enqueueMediaMigration).mockClear();
  await getStore().setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  await requestMediaMigration('org');
  expect(enqueueMediaMigration).toHaveBeenCalledExactlyOnceWith('org');
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
  await requestMediaMigration('org');
  const { executeMediaMigration } = await import('../../lib/publishing/media-migration');
  for (let batch = 0; batch < 11; batch++) {
    const delay = await executeMediaMigration('org');
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
  await requestMediaMigration('org'); await runMediaMigrationBatch('org', 1);
  await store.setDoc(`${mediaPath}/a`, fixtureMedia('a'));
  await requestMediaMigration('org');
  await runMediaMigrationBatch('org');
  expect((await mediaMigrationStatus('org'))?.state).toBe('queued');
  await runMediaMigrationBatch('org');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 2, copied_bytes: 6 });
  expect((await store.getDoc<any>(`${mediaPath}/a`)).storage.provider).toBe('organization_r2');
});

it('recovers a crash after the copy was saved but before its cursor, without recopying or double counting', async () => {
  const store = getStore(); const mediaPath = `${paths.media('org', 'site')}/image`;
  await store.setDoc(mediaPath, fixtureMedia('image'));
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => goodBody());
  await requestMediaMigration('org');
  const compare = store.compareAndUpdateDoc.bind(store);
  let crashed = false;
  vi.spyOn(store, 'compareAndUpdateDoc').mockImplementation(async (path, check, patch) => {
    if (!crashed && patch.cursor?.media === 'image') { crashed = true; throw new Error('process interrupted'); }
    return compare(path, check, patch);
  });
  await runMediaMigrationBatch('org');
  const job = (await store.listDocs<any>('publishing_media_migrations'))[0];
  expect(job).toMatchObject({ state: 'queued', copied_files: 0, cursor: { media: '' } });
  await store.updateDoc(`publishing_media_migrations/${job.id}`, { retry_at: 0 });
  await runMediaMigrationBatch('org');
  expect(await mediaMigrationStatus('org')).toMatchObject({ state: 'complete', copied_files: 1, copied_bytes: 3 });
  expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
});

it('retries an interrupted transfer automatically and pauses after three unsuccessful attempts', async () => {
  const store = getStore();
  await store.setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('temporary unavailable'));
  await requestMediaMigration('org');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = (await store.listDocs<any>('publishing_media_migrations'))[0];
    await store.updateDoc(`publishing_media_migrations/${job.id}`, { retry_at: 0 });
    await runMediaMigrationBatch('org');
    expect((await mediaMigrationStatus('org'))?.state).toBe(attempt === 3 ? 'failed' : 'queued');
  }
  expect((await mediaMigrationStatus('org'))?.error).toContain('three attempts');
});

it('lets only one worker copy while a duplicate delivery observes the active lease', async () => {
  const store = getStore();
  await store.setDoc(`${paths.media('org', 'site')}/image`, fixtureMedia('image'));
  let duplicateChecked = false;
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => {
    if (!duplicateChecked) {
      duplicateChecked = true;
      const { executeMediaMigration } = await import('../../lib/publishing/media-migration');
      expect(await executeMediaMigration('org')).toBeGreaterThan(0);
    }
    return goodBody();
  });
  await requestMediaMigration('org'); await runMediaMigrationBatch('org');
  expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
  expect((await mediaMigrationStatus('org'))?.state).toBe('complete');
});
