// Stored SVG media must be inert wherever its bytes become media: direct
// uploads to organization or draft storage, URL/WordPress imports, and
// platform (legacy) storage whose keys are all public.
vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => false), copyWithTransferService: vi.fn(), verifyWithTransferService: vi.fn() }));
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { MAIN_VERSION_ID, paths, type Media } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { createMediaUpload } from '../../lib/publishing/media-storage';
import { copyWithTransferService } from '../../lib/media/remote-transfer';
import { finalizeOrganizationMedia, resanitizeStoredSvgMedia, type SvgMedia } from '../../lib/media/svg-media';
import { finalizeMedia, MediaIntegrityError } from '../../lib/media-finalize';
import { WPMediaTransfer } from '../../lib/wp/media';

const account = 'a'.repeat(32);
const MALICIOUS = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script><a href="javascript:alert(2)"><rect width="10" height="10" fill="#f00"/></a></svg>');
const NOT_SVG = Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface StoredObject { body: Buffer; etag: string; contentType?: string; cacheControl?: string; disposition?: string }
const objects = new Map<string, StoredObject>();
let etags = 0;
/** Called after each command; tests use it to model a concurrent writer. */
let afterSend: (command: unknown) => void = () => {};

function expectInert(body: Buffer) {
  const text = body.toString('utf8');
  expect(text).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  expect(text).not.toMatch(/<script|onload|javascript:|<\?xml/i);
}

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  objects.clear(); afterSend = () => {};
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  vi.stubEnv('DEPLOY_QUEUE', 'firestore');
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('R2_BUCKET', 'legacy-public');
  vi.stubEnv('R2_PRIVATE_BUCKET', 'private-drafts');
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://cdn.example.com');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-draft-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-draft-secret');
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => {
    const input = command.input, id = `${input.Bucket}/${input.Key}`;
    let result: unknown = {};
    if (command instanceof GetObjectCommand) {
      const object = objects.get(id);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (input.IfMatch && input.IfMatch !== object.etag) throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
      result = { Body: { transformToByteArray: async () => new Uint8Array(object.body) }, ContentLength: object.body.length, ETag: object.etag };
    } else if (command instanceof PutObjectCommand) {
      const etag = `"etag-${++etags}"`;
      objects.set(id, { body: Buffer.from(input.Body as Uint8Array), etag, contentType: input.ContentType, cacheControl: input.CacheControl });
      result = { ETag: etag };
    } else if (command instanceof CopyObjectCommand) {
      const source = objects.get(input.CopySource);
      if (!source) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (input.CopySourceIfMatch && input.CopySourceIfMatch !== source.etag) throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
      objects.set(id, { body: source.body, etag: `"etag-${++etags}"`, contentType: input.ContentType, cacheControl: input.CacheControl, disposition: input.ContentDisposition });
    } else if (command instanceof DeleteObjectCommand) objects.delete(id);
    afterSend(command);
    return result as never;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function connect() {
  await getStore().setDoc(connectionPath('org', 'cloudflare'), {
    revision: 'connected-revision', status: 'connected', media_ready: true,
    cloudflare: { account_id: account, bucket: 'customer-private', public_bucket: 'customer-public' },
    encrypted_credentials: sealCredentials('org', 'cloudflare', { access_key_id: 'synthetic-customer-key', secret_access_key: 'synthetic-customer-secret' }),
  });
}
const mediaDoc = (id: string) => getStore().getDoc<SvgMedia>(`${paths.media('org', 'site')}/${id}`);

describe('organization storage uploads', () => {
  beforeEach(async () => {
    await getStore().setDoc(paths.site('org', 'site'), { media_id: 'abcdefghij', publishing_mode: 'customer_git' });
    await connect();
  });

  async function upload(body: Buffer, contentType = 'image/svg+xml', filename = 'logo.svg') {
    const created = await createMediaUpload('org', 'site', { filename, contentType, size: body.length, actor: 'test' });
    objects.set(`customer-private/${created.key}`, { body, etag: '"client-put"', contentType });
    return created;
  }

  it('freezes only sanitized bytes and accepts the hash of the file that was sent', async () => {
    const created = await upload(MALICIOUS);
    const result = await finalizeOrganizationMedia('org', 'site', created.mediaId, sha(MALICIOUS));
    const saved = await mediaDoc(created.mediaId);
    expect(saved?.storage?.state).toBe('ready');
    const frozen = objects.get(`customer-private/${saved!.storage!.key}`)!;
    expectInert(frozen.body);
    expect(frozen.body.toString()).toContain('<rect width="10" height="10" fill="#f00"/>');
    expect(frozen.contentType).toBe('image/svg+xml');
    expect(saved?.sha256).toBe(sha(frozen.body));
    expect(saved?.size_bytes).toBe(frozen.body.length);
    expect(result).toMatchObject({ sha256: sha(frozen.body), svg_sanitized: true, source_sha256: sha(MALICIOUS) });
    // A retried finalize with the original hash is still accepted.
    await expect(finalizeOrganizationMedia('org', 'site', created.mediaId, sha(MALICIOUS))).resolves.toMatchObject({ sha256: sha(frozen.body) });
  });

  it('treats non-canonical SVG types and .svg names as SVG', async () => {
    for (const [type, name] of [['image/SVG+xml', 'a.svg'], ['image/x-icon+xml', 'b.bin'], ['image/png', 'c.SVG']]) {
      // New uploads must name a matching extension; records created before that rule keep any combination.
      const created = await upload(MALICIOUS, 'image/svg+xml', 'legacy.svg');
      await getStore().updateDoc(`${paths.media('org', 'site')}/${created.mediaId}`, { mime_type: type, filename: name });
      await finalizeOrganizationMedia('org', 'site', created.mediaId);
      const saved = await mediaDoc(created.mediaId);
      expect(saved?.mime_type).toBe('image/svg+xml');
      expectInert(objects.get(`customer-private/${saved!.storage!.key}`)!.body);
    }
  });

  it('refuses bytes replaced by a replayed upload grant after sanitizing', async () => {
    const created = await upload(MALICIOUS);
    afterSend = command => {
      if (command instanceof PutObjectCommand && command.input.Key === created.key) {
        // Same length as the sanitized file, so only the hash pin can notice.
        const head = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">', tail = '</svg>';
        const swapped = Buffer.from(head + ' '.repeat((command.input.Body as Buffer).length - head.length - tail.length) + tail);
        objects.set(`customer-private/${created.key}`, { body: swapped, etag: '"replayed"' });
      }
    };
    await expect(finalizeOrganizationMedia('org', 'site', created.mediaId)).rejects.toMatchObject({ status: 422, code: 'media_integrity_failed' });
    expect((await mediaDoc(created.mediaId))?.storage?.state).toBe('uploading');
    expect([...objects.keys()].some(key => key.includes('/originals/'))).toBe(false);
  });

  it('rejects a file that is not a usable SVG with 400 and freezes nothing', async () => {
    const created = await upload(NOT_SVG);
    await expect(finalizeOrganizationMedia('org', 'site', created.mediaId)).rejects.toMatchObject({ status: 400, code: 'media_svg_invalid' });
    expect((await mediaDoc(created.mediaId))?.storage?.state).toBe('uploading');
    expect([...objects.keys()].some(key => key.includes('/originals/'))).toBe(false);
  });

  it('leaves other media byte-identical', async () => {
    const png = Buffer.from('synthetic-png-bytes');
    const created = await upload(png, 'image/png', 'photo.png');
    await finalizeOrganizationMedia('org', 'site', created.mediaId, sha(png));
    const saved = await mediaDoc(created.mediaId);
    expect(objects.get(`customer-private/${saved!.storage!.key}`)!.body.equals(png)).toBe(true);
    expect(vi.mocked(S3Client.prototype.send).mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('re-sanitizes SVGs finalized before sanitizing existed, dry run first', async () => {
    const key = 'private/media/abcdefghij/originals/old/logo.svg';
    objects.set(`customer-private/${key}`, { body: MALICIOUS, etag: '"old"' });
    await getStore().setDoc(`${paths.media('org', 'site')}/old`, { filename: 'logo.svg', mime_type: 'image/svg+xml', cdn_url: 'https://cms.example.com/x', r2_key: key,
      sha256: sha(MALICIOUS), size_bytes: MALICIOUS.length, storage: { provider: 'organization_r2', account_id: account, bucket: 'customer-private', key, generation: 'connected-revision', state: 'ready' } });
    const dry = await resanitizeStoredSvgMedia('org', 'site');
    expect(dry.sanitized).toHaveLength(1);
    expect((await mediaDoc('old'))?.sha256).toBe(sha(MALICIOUS));
    const applied = await resanitizeStoredSvgMedia('org', 'site', { apply: true });
    const saved = await mediaDoc('old');
    expect(saved?.sha256).toBe(applied.sanitized[0].sha256);
    expect(saved?.storage?.key).toContain(`/originals/${saved?.sha256}/`);
    expectInert(objects.get(`customer-private/${saved!.storage!.key}`)!.body);
    expect((await resanitizeStoredSvgMedia('org', 'site')).unchanged).toBe(1);
  });
});

describe('URL and WordPress imports', () => {
  beforeEach(async () => {
    await getStore().setDoc(paths.site('org', 'site'), { media_id: 'abcdefghij', publishing_mode: 'customer_git' });
    await getStore().setDoc(paths.version('org', 'site', 'main'), { kind: 'main' });
    await connect();
  });
  function workerCopies(body: Buffer) {
    vi.mocked(copyWithTransferService).mockReset().mockImplementation(async input => {
      const etag = '"worker-copy"';
      objects.set(`${input.bucket}/${input.key}`, { body, etag, contentType: input.contentType });
      return { protocol: 1, id: 'synthetic', sha256: sha(body), size: body.length, etag };
    });
  }

  it('stores the sanitized version of an imported SVG and freezes exactly that version', async () => {
    workerCopies(MALICIOUS);
    const result = await new WPMediaTransfer('org', 'site', getStore()).importUrl('https://wordpress.example.com/uploads/logo.svg');
    expect(result.contentType).toBe('image/svg+xml');
    const saved = await mediaDoc(result.mediaId);
    expect(saved?.storage?.state).toBe('ready');
    const frozen = objects.get(`customer-private/${saved!.storage!.key}`)!;
    expectInert(frozen.body);
    expect(saved?.sha256).toBe(sha(frozen.body));
    const copy = vi.mocked(S3Client.prototype.send).mock.calls.map(([command]) => command).find(command => command instanceof CopyObjectCommand) as CopyObjectCommand;
    expect(copy.input.CopySourceIfMatch).not.toBe('"worker-copy"');
  });

  it('records a source that is not an SVG once and does not retry it', async () => {
    workerCopies(NOT_SVG);
    const transfer = new WPMediaTransfer('org', 'site', getStore());
    await expect(transfer.ensureUrl('https://wordpress.example.com/uploads/bad.svg')).rejects.toMatchObject({ code: 'media_svg_invalid' });
    await expect(new WPMediaTransfer('org', 'site', getStore()).ensureUrl('https://wordpress.example.com/uploads/bad.svg')).rejects.toMatchObject({ code: 'media_svg_invalid' });
    const docs = await getStore().listDocs<SvgMedia & { import_pending?: boolean }>(paths.media('org', 'site'));
    expect(docs).toHaveLength(1);
    expect(docs[0].import_pending).toBe(false);
    expect(docs[0].storage?.state).toBe('uploading');
    expect(copyWithTransferService).toHaveBeenCalledTimes(1);
  });
});

describe('platform storage', () => {
  const config = { accountId: 'b'.repeat(32), bucket: 'legacy-public', accessKeyId: 'k', secretAccessKey: 's', publicBase: 'https://cdn.example.com' };
  async function seed(doc: Partial<SvgMedia>) {
    await getStore().setDoc(paths.site('org', 'site'), { media_id: 'abcdefghij' });
    await getStore().setDoc(`${paths.media('org', 'site')}/m1`, { filename: 'logo.svg', mime_type: 'image/svg+xml', r2_key: 'media/abcdefghij/1-logo.svg',
      cdn_url: 'https://cdn.example.com/media/abcdefghij/1-logo.svg', created_at: new Date().toISOString(), ...doc });
  }

  it('publishes only sanitized bytes from private staging', async () => {
    await seed({ svg_staging_key: 'svg-staging/media/abcdefghij/u/logo.svg' });
    objects.set('private-drafts/svg-staging/media/abcdefghij/u/logo.svg', { body: MALICIOUS, etag: '"client-put"' });
    const result = await finalizeMedia('org', 'site', 'm1', config, { expectedSha256: sha(MALICIOUS) });
    const published = objects.get('legacy-public/media/abcdefghij/1-logo.svg')!;
    expectInert(published.body);
    expect(published).toMatchObject({ contentType: 'image/svg+xml', cacheControl: 'public, max-age=31536000, immutable' });
    expect(result).toMatchObject({ sha256: sha(published.body), svg_sanitized: true, source_sha256: sha(MALICIOUS) });
    expect(objects.has('private-drafts/svg-staging/media/abcdefghij/u/logo.svg')).toBe(false);
    expect(await mediaDoc('m1')).toMatchObject({ svg_staging_key: null, size_bytes: published.body.length });
    // Deploy backfill and client retries finalize again without changing the bytes.
    await finalizeMedia('org', 'site', 'm1', config, { expectedSha256: sha(MALICIOUS) });
    expect(objects.get('legacy-public/media/abcdefghij/1-logo.svg')!.body.equals(published.body)).toBe(true);
  });

  it('rewrites an SVG uploaded before sanitizing existed in place', async () => {
    await seed({});
    objects.set('legacy-public/media/abcdefghij/1-logo.svg', { body: MALICIOUS, etag: '"old"' });
    await finalizeMedia('org', 'site', 'm1', config);
    expectInert(objects.get('legacy-public/media/abcdefghij/1-logo.svg')!.body);
  });

  it('quarantines a public file that cannot be sanitized as a download', async () => {
    await seed({});
    objects.set('legacy-public/media/abcdefghij/1-logo.svg', { body: NOT_SVG, etag: '"old"' });
    await expect(finalizeMedia('org', 'site', 'm1', config)).rejects.toMatchObject({ status: 400, code: 'media_svg_invalid' });
    expect(objects.get('legacy-public/media/abcdefghij/1-logo.svg')).toMatchObject({ contentType: 'application/octet-stream', disposition: 'attachment' });
    objects.set('legacy-public/media/abcdefghij/1-logo.svg', { body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)'), etag: '"cut"' });
    await expect(finalizeMedia('org', 'site', 'm1', config)).rejects.toBeInstanceOf(MediaIntegrityError);
    expect(objects.get('legacy-public/media/abcdefghij/1-logo.svg')).toMatchObject({ contentType: 'application/octet-stream', disposition: 'attachment' });
  });
});

describe('platform storage routes', () => {
  async function callRoute(route: Promise<Partial<Record<'POST', APIRoute>>>, url: string, params: Record<string, string>, token: string, body: unknown) {
    const handler = (await route).POST!;
    return handler({ request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
      params, cookies: { get: () => undefined }, locals: {} } as any) as Promise<Response>;
  }
  async function setup() {
    await getStore().setDoc(paths.site('org', 'site'), { name: 'Synthetic', media_id: 'abcdefghij', created_at: new Date().toISOString() });
    await getStore().setDoc(paths.version('org', 'site', MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString() });
    const { createApiKey } = await import('../../lib/api-keys');
    return (await createApiKey({ orgId: 'org', siteId: 'site', name: 'test', createdBy: 'admin@example.com' })).token;
  }

  it('never grants a public PUT for an SVG and serves only sanitized bytes after finalize', async () => {
    const token = await setup();
    const response = await callRoute(import('../../pages/api/v1/sites/[siteId]/media/upload-url'), 'https://cms.example.com/api/v1/sites/site/media/upload-url',
      { siteId: 'site' }, token, { filename: 'logo.svg', content_type: 'image/svg+xml', size: MALICIOUS.length });
    expect(response.status).toBe(200);
    const data = await response.json() as { upload_url: string; key: string; media_id: string };
    const grant = new URL(data.upload_url);
    expect(grant.hostname.split('.')[0]).toBe('private-drafts');
    expect(grant.pathname).toMatch(/^\/svg-staging\//);
    expect(grant.pathname).not.toContain(data.key);
    objects.set(`private-drafts${grant.pathname}`, { body: MALICIOUS, etag: '"client-put"' });
    const finalized = await callRoute(import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/finalize'), `https://cms.example.com/api/v1/sites/site/media/${data.media_id}/finalize`,
      { siteId: 'site', mediaId: data.media_id }, token, {});
    expect(finalized.status).toBe(200);
    expectInert(objects.get(`legacy-public/${data.key}`)!.body);

    const png = await callRoute(import('../../pages/api/v1/sites/[siteId]/media/upload-url'), 'https://cms.example.com/api/v1/sites/site/media/upload-url',
      { siteId: 'site' }, token, { filename: 'photo.png', content_type: 'image/png' });
    const pngData = await png.json() as { upload_url: string; key: string };
    expect(new URL(pngData.upload_url).hostname.split('.')[0]).toBe('legacy-public');
    expect(new URL(pngData.upload_url).pathname).toBe(`/${pngData.key}`);
  });

  it('answers 400 for an SVG upload that cannot be sanitized', async () => {
    const token = await setup();
    const response = await callRoute(import('../../pages/api/v1/sites/[siteId]/media/upload-url'), 'https://cms.example.com/api/v1/sites/site/media/upload-url',
      { siteId: 'site' }, token, { filename: 'logo.svg', content_type: 'image/svg+xml' });
    const data = await response.json() as { upload_url: string; media_id: string };
    objects.set(`private-drafts${new URL(data.upload_url).pathname}`, { body: NOT_SVG, etag: '"client-put"' });
    const finalized = await callRoute(import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/finalize'), `https://cms.example.com/api/v1/sites/site/media/${data.media_id}/finalize`,
      { siteId: 'site', mediaId: data.media_id }, token, {});
    expect(finalized.status).toBe(400);
    expect(await finalized.json()).toMatchObject({ code: 'media_svg_invalid' });
    expect([...objects.keys()].some(key => key.startsWith('legacy-public/'))).toBe(false);
  });

  it('refuses SVG uploads when no private staging bucket exists', async () => {
    const token = await setup();
    vi.stubEnv('R2_PRIVATE_BUCKET', '');
    const response = await callRoute(import('../../pages/api/v1/sites/[siteId]/media/upload-url'), 'https://cms.example.com/api/v1/sites/site/media/upload-url',
      { siteId: 'site' }, token, { filename: 'logo.svg', content_type: 'image/svg+xml' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'svg_staging_unavailable' });
  });
});
