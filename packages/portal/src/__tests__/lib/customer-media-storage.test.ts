vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => false) }));
// Queue delivery has separate tests. Do not let a local background migration
// outlive its fixture and run against the following test's datastore spy.
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client, GetObjectCommand, CopyObjectCommand } from '../../lib/net/s3';
import { paths, type Media } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { createMediaUpload, finalizeStoredMedia, privateMediaReadUrl, authorizePreviewMedia, preparedVariantSlots } from '../../lib/publishing/media-storage';

const account = 'a'.repeat(32);
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('R2_BUCKET', 'legacy-public');
  vi.stubEnv('R2_PRIVATE_BUCKET', 'private-drafts');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-draft-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-draft-secret');
  await getStore().setDoc(paths.site('org', 'site'), { media_id: 'abcdefghij', publishing_mode: 'customer_git' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function connect() {
  await getStore().setDoc(connectionPath('org', 'cloudflare'), {
    revision: 'connected-revision', status: 'connected', media_ready: true,
    cloudflare: { account_id: account, bucket: 'customer-private', public_bucket: 'customer-public' },
    encrypted_credentials: sealCredentials('org', 'cloudflare', { access_key_id: 'synthetic-customer-key', secret_access_key: 'synthetic-customer-secret' }),
  });
}

it('uploads directly to the owner account and stores no bearer URLs or credentials', async () => {
  await connect();
  const result = await createMediaUpload('org', 'site', { filename: 'photo.png', contentType: 'image/png', size: 3, actor: 'test' });
  expect(new URL(result.uploadUrl).host).toBe(`${account}.r2.cloudflarestorage.com`);
  expect(new URL(result.uploadUrl).pathname).toContain('/customer-private/private/media/abcdefghij/uploads/');
  const saved = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${result.mediaId}`);
  expect(saved?.storage?.provider).toBe('organization_r2');
  expect(saved?.cdn_url).toBe(`https://cms.example.com/api/sites/site/media/${result.mediaId}/content`);
  expect(JSON.stringify(saved)).not.toMatch(/X-Amz|synthetic-customer|secret_access_key/);
});

it('uses private draft storage before setup but never falls back after a customer disconnect', async () => {
  const before = await createMediaUpload('org', 'site', { filename: 'first.pdf', contentType: 'application/pdf', actor: 'test' });
  expect(before.storage).toBe('draft_r2');
  expect(new URL(before.uploadUrl).pathname).toContain('/private-drafts/');
  await connect();
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { status: 'disconnected', encrypted_credentials: null });
  await expect(createMediaUpload('org', 'site', { filename: 'second.pdf', contentType: 'application/pdf', actor: 'test' })).rejects.toThrow('original R2');
});

it('verifies immutable bytes and finalizes late grants at their recorded destination', async () => {
  const upload = await createMediaUpload('org', 'site', { filename: 'letter.pdf', contentType: 'application/pdf', size: 3, actor: 'test' });
  await connect();
  const sends: unknown[] = [];
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
    sends.push(command);
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3, ETag: 'etag-before-copy' };
    return {};
  });
  const result = await finalizeStoredMedia('org', 'site', upload.mediaId);
  expect(result.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const copied = sends.find(command => command instanceof CopyObjectCommand) as CopyObjectCommand;
  expect(copied.input.Bucket).toBe('private-drafts');
  expect(copied.input.Key).not.toBe(upload.key);
  expect(copied.input.CopySourceIfMatch).toBe('etag-before-copy');
  const saved = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${upload.mediaId}`);
  expect(saved?.storage?.state).toBe('ready');
  expect(saved?.storage?.provider).toBe('draft_r2');
  const read = await privateMediaReadUrl('org', 'site', upload.mediaId, 8);
  expect(new URL(read).searchParams.get('X-Amz-Expires')).toBe('8');
  await expect(privateMediaReadUrl('another-org', 'site', upload.mediaId)).rejects.toThrow('not ready');
});

it('does not publish or freeze corrupt uploads', async () => {
  await connect();
  const upload = await createMediaUpload('org', 'site', { filename: 'letter.pdf', contentType: 'application/pdf', actor: 'test' });
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({ Body: { transformToByteArray: async () => Buffer.from('abc') }, ContentLength: 3, ETag: 'etag' }));
  await expect(finalizeStoredMedia('org', 'site', upload.mediaId, '0'.repeat(64))).rejects.toThrow('does not match');
  expect(send).toHaveBeenCalledTimes(1);
  const saved = await getStore().getDoc<Media>(`${paths.media('org', 'site')}/${upload.mediaId}`);
  expect(saved?.storage?.state).toBe('uploading');
});


it('authorizes only referenced private images for opaque preview frames without scanning the library', async () => {
  await connect();
  const store = getStore(), url = 'https://cms.example.com/api/sites/site/media/photo/content';
  await store.setDoc(`${paths.media('org', 'site')}/photo`, { filename: 'photo.png', mime_type: 'image/png', cdn_url: url,
    storage: { provider: 'organization_r2', account_id: account, bucket: 'customer-private', key: 'private/photo.png', state: 'ready' } });
  const scans = vi.spyOn(store, 'listDocs');
  const reads = vi.spyOn(store, 'getDoc');
  const html = await authorizePreviewMedia(`<img src="${url}"><div style="background:url('${url}')"></div>`, 'org', 'site', 30);
  expect(html).not.toContain('/api/sites/');
  expect(html).toContain('X-Amz-Expires=30');
  expect(html).toContain(`${account}.r2.cloudflarestorage.com`);
  expect(scans).not.toHaveBeenCalled();
  expect(reads.mock.calls.filter(([path]) => path === `${paths.media('org', 'site')}/photo`)).toHaveLength(1);
  const otherSite = url.replace('/sites/site/', '/sites/another-site/');
  expect(await authorizePreviewMedia(`<img src="${otherSite}">`, 'org', 'site')).toContain(otherSite);
});

it('authorizes independent preview media with bounded parallel reads', async () => {
  const store = getStore(), prefix = paths.media('org', 'site') + '/';
  const ids = Array.from({ length: 9 }, (_, i) => `parallel-${i}`);
  const url = (id: string) => `https://cms.example.com/api/sites/site/media/${id}/content`;
  for (const id of ids) await store.setDoc(prefix + id, {
    filename: id + '.png', mime_type: 'image/png', cdn_url: url(id),
    storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: `private/${id}.png`, state: 'ready' },
  });
  const originalRead = store.getDoc.bind(store);
  let active = 0, maximum = 0, mediaReads = 0;
  vi.spyOn(store, 'getDoc').mockImplementation(async path => {
    if (!path.startsWith(prefix)) return originalRead(path);
    mediaReads++; active++; maximum = Math.max(maximum, active);
    try { return await originalRead(path); } finally { active--; }
  });
  const html = await authorizePreviewMedia(ids.map(id => `<img src="${url(id)}">`).join(''), 'org', 'site');
  expect(html.match(/X-Amz-Expires=/g)).toHaveLength(9);
  expect(mediaReads).toBe(9);
  expect(maximum).toBe(4);
});

describe('review preview images', () => {
  const sha = 'c'.repeat(64);
  const prepared = (overrides: Partial<Media> = {}) => ({ filename: 'oven.png', mime_type: 'image/png', width: 2048, height: 1360, sha256: sha,
    cdn_url: 'https://cms.example.com/api/sites/site/media/oven/content',
    storage: { provider: 'organization_r2', account_id: account, bucket: 'customer-private', key: 'private/media/abcdefghij/oven.png', state: 'ready' },
    preparation: { state: 'ready', source_sha256: sha, recipe: 'v2' }, ...overrides });

  it('lists the prepared sizes below the image width, and none before preparation', () => {
    expect(preparedVariantSlots(prepared() as Media)).toEqual([
      { slot: 'w320', width: 320 }, { slot: 'w640', width: 640 }, { slot: 'w1024', width: 1024 }, { slot: 'w1920', width: 1920 }, { slot: 'original', width: 2048 }]);
    expect(preparedVariantSlots(prepared({ width: 800 }) as Media)?.map(entry => entry.slot)).toEqual(['w320', 'w640', 'original']);
    expect(preparedVariantSlots(prepared({ preparation: { state: 'ready', source_sha256: 'd'.repeat(64), recipe: 'v2' } }) as Media)).toBeNull();
    expect(preparedVariantSlots(prepared({ preparation: undefined }) as Media)).toBeNull();
  });

  it('signs a prepared variant that the browser may keep, and refuses one that does not exist', async () => {
    await connect();
    await getStore().setDoc(`${paths.media('org', 'site')}/oven`, prepared());
    const variant = new URL(await privateMediaReadUrl('org', 'site', 'oven', 7200, { variant: 'w640.avif', cacheSeconds: 3600 }));
    expect(variant.pathname).toBe(`/customer-private/private/media/abcdefghij/prepared/v2/${sha}/w640.avif`);
    expect(variant.searchParams.get('response-cache-control')).toBe('private, max-age=3600');
    expect(variant.searchParams.get('response-content-type')).toBe('image/avif');
    expect(variant.searchParams.get('X-Amz-Expires')).toBe('3660');
    await expect(privateMediaReadUrl('org', 'site', 'oven', 7200, { variant: 'w4000.avif' })).rejects.toMatchObject({ code: 'media_variant_unavailable' });
    await expect(privateMediaReadUrl('org', 'site', 'oven', 7200, { variant: '../oven.png' })).rejects.toMatchObject({ code: 'media_variant_unavailable' });
    // Without a cache window the original stays uncached and short-lived, as before.
    const original = new URL(await privateMediaReadUrl('org', 'site', 'oven', 30));
    expect(original.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(original.searchParams.get('X-Amz-Expires')).toBe('30');
  });

  it('gives preview images the publication\'s <picture> with prepared AVIF and WebP sources', async () => {
    await connect();
    await getStore().setDoc(`${paths.media('org', 'site')}/oven`, prepared());
    await getStore().setDoc(`${paths.media('org', 'site')}/new`, prepared({ preparation: undefined }));
    const { withPreviewResponsiveImages } = await import('../../lib/preview-media');
    const src = (id: string) => `/preview/site/media/${id}?token=tok`;
    const html = await withPreviewResponsiveImages(`<img src="${src('oven')}" alt="Oven" loading="lazy" decoding="async" /><img src="${src('new')}" alt="New" loading="lazy" />`, 'org', 'site', 'tok');
    expect(html).toContain(`<source type="image/avif" srcset="${src('oven')}&amp;variant=w320.avif 320w`);
    expect(html).toContain(`${src('oven')}&amp;variant=original.webp 2048w`);
    expect(html).toContain('width="2048" height="1360"');
    // The first image is the likely largest paint, as on the published site.
    expect(html).toMatch(/alt="Oven"[^>]*loading="eager"[^>]*fetchpriority="high"/);
    // Not prepared yet: the original file, without sources.
    expect(html).toContain(`<img src="${src('new')}"`);
    expect(html.match(/<picture>/g)).toHaveLength(1);
  });
});

describe('preview media route', () => {
  it('lets the browser keep a preview image for the review, bounded by the link', async () => {
    vi.stubEnv('PREVIEW_HMAC_SECRET', 'synthetic-preview-secret-for-tests-only-0123456789');
    await connect();
    const sha = 'c'.repeat(64);
    await getStore().setDoc(`${paths.media('org', 'site')}/oven`, { filename: 'oven.png', mime_type: 'image/png', width: 2048, height: 1360, sha256: sha,
      storage: { provider: 'organization_r2', account_id: account, bucket: 'customer-private', key: 'private/media/abcdefghij/oven.png', state: 'ready' },
      preparation: { state: 'ready', source_sha256: sha, recipe: 'v2' } });
    const { signPreviewTicket } = await import('../../lib/preview-signing');
    const { GET } = await import('../../pages/preview/[siteId]/media/[mediaId]');
    const get = async (ttlSeconds: number, query = '') => {
      const { token } = signPreviewTicket({ orgId: 'org', siteId: 'site', versionId: 'main', ttlSeconds });
      return GET({ params: { siteId: 'site', mediaId: 'oven' }, request: new Request(`https://cms.example.com/preview/site/media/oven?token=${encodeURIComponent(token)}${query}`) } as never);
    };
    const day = await get(86400, '&variant=w1024.webp');
    expect(day.status).toBe(302);
    expect(day.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(new URL(day.headers.get('Location')!).pathname).toContain(`/prepared/v2/${sha}/w1024.webp`);
    // A link about to expire is not cached past its expiry.
    expect((await get(100)).headers.get('Cache-Control')).toBe('private, no-store');
    expect((await get(86400, '&variant=w4000.webp')).status).toBe(404);
  });
});

describe('preview images stored without dimensions', () => {
  it('serves the original before legacy width hydration finishes, then reuses prepared variants', async () => {
    await connect();
    const sha = 'e'.repeat(64);
    await getStore().setDoc(`${paths.media('org', 'site')}/house`, { filename: 'house.png', mime_type: 'image/png', sha256: sha,
      cdn_url: 'https://cms.example.com/api/sites/site/media/house/content',
      storage: { provider: 'organization_r2', account_id: account, bucket: 'customer-private', key: 'private/media/abcdefghij/house.png', state: 'ready' },
      preparation: { state: 'ready', source_sha256: sha, recipe: 'v2' } });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
      expect((command as GetObjectCommand).input.Key).toBe(`private/media/abcdefghij/prepared/v2/${sha}/original.webp.receipt.json`);
      await blocked;
      return { Body: { transformToByteArray: async () => Buffer.from(JSON.stringify({ source_sha256: sha, recipe_sha256: 'r', width: 1536, format: 'webp', sha256: 'f'.repeat(64), size_bytes: 1 })) } };
    });
    const { withPreviewResponsiveImages } = await import('../../lib/preview-media');
    const { withBackgroundTasks } = await import('../../lib/runtime/background-tasks');
    const background: Promise<unknown>[] = [];
    const src = '/preview/site/media/house?token=tok';
    const first = await withBackgroundTasks(task => background.push(task), () =>
      withPreviewResponsiveImages(`<img src="${src}" alt="House" loading="lazy" />`, 'org', 'site', 'tok'));
    expect(first).toContain(`src="${src}"`);
    expect(first).not.toContain('variant=');
    release();
    await Promise.all(background);
    const html = await withPreviewResponsiveImages(`<img src="${src}" alt="House" loading="lazy" />`, 'org', 'site', 'tok');
    expect(html).toContain(`${src}&amp;variant=w1024.avif 1024w, ${src}&amp;variant=original.avif 1536w`);
    expect(html).not.toContain('variant=w1920');
    expect(await getStore().getDoc(`${paths.media('org', 'site')}/house`)).toMatchObject({ prepared_width: 1536 });
    expect(send).toHaveBeenCalledTimes(1);
    // The next preview uses the kept width without reading the receipt again.
    await withPreviewResponsiveImages(`<img src="${src}" alt="House" loading="lazy" />`, 'org', 'site', 'tok');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
