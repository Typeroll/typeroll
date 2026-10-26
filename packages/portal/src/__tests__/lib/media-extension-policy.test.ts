// Static website hosts serve media with the Content-Type of the file
// extension. A write-level user must not be able to publish bytes under an
// .html, .svg, .xml or .js name that does not match the verified media type,
// and SVG must never be published or migrated without sanitizing.
vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => false), copyWithTransferService: vi.fn(), verifyWithTransferService: vi.fn() }));
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));
vi.mock('../../lib/publishing/media-domain', () => ({ preparePublicMediaDomains: vi.fn(async () => true) }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireSiteAccess: vi.fn(async () => ({ ok: true, value: {
    session: { userId: 'editor', orgId: 'org' }, owner_org_id: 'org', permission: 'write',
    site: await getStore().getDoc(paths.site('org', 'site')),
  } })),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths, type Media } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createApiKey } from '../../lib/api-keys';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { getOrganizationDomains, saveOrganizationDomains } from '../../lib/publishing/domain-config';
import { createMediaUpload, finalizeStoredMedia } from '../../lib/publishing/media-storage';
import { publicationMediaManifest, publishableMediaPath, retainDistinctMediaManifests } from '../../lib/publishing/media-manifest';
import { requestMediaMigration, runMediaMigrationBatch } from '../../lib/publishing/media-migration';
import { copyWithTransferService } from '../../lib/media/remote-transfer';
import { assertMediaName, assertMediaNameUpdate, mediaNameMatchesType, withMediaExtension } from '../../lib/media/file-types';
import { finalizeUpload, MediaFinalizeError } from '../../lib/media/client-upload';
import { WPMediaTransfer } from '../../lib/wp/media';
import type { SvgMedia } from '../../lib/media/svg-media';

const account = 'a'.repeat(32);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const MALICIOUS = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script><rect width="1" height="1"/></svg>');
const NOT_SVG = Buffer.from('<html><script>alert(1)</script></html>');

interface StoredObject { body: Buffer; etag: string; contentType?: string }
const objects = new Map<string, StoredObject>();
let etags = 0;

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  objects.clear();
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
    if (command instanceof GetObjectCommand) {
      const object = objects.get(id);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (input.IfMatch && input.IfMatch !== object.etag) throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
      return { Body: { transformToByteArray: async () => new Uint8Array(object.body) }, ContentLength: object.body.length, ETag: object.etag } as never;
    }
    if (command instanceof PutObjectCommand) {
      const etag = `"etag-${++etags}"`;
      objects.set(id, { body: Buffer.from(input.Body as Uint8Array), etag, contentType: input.ContentType });
      return { ETag: etag } as never;
    }
    if (command instanceof CopyObjectCommand) {
      const source = objects.get(input.CopySource);
      if (!source) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (input.CopySourceIfMatch && input.CopySourceIfMatch !== source.etag) throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
      objects.set(id, { body: source.body, etag: `"etag-${++etags}"`, contentType: input.ContentType });
    } else if (command instanceof DeleteObjectCommand) objects.delete(id);
    return {} as never;
  });
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Synthetic', media_id: 'abcdefghij', publishing_mode: 'customer_git', created_at: new Date().toISOString() });
  await getStore().setDoc(paths.version('org', 'site', MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString() });
  await getStore().setDoc(connectionPath('org', 'cloudflare'), {
    revision: 'connected-revision', status: 'connected', media_ready: true,
    cloudflare: { account_id: account, bucket: 'customer-private', public_bucket: 'customer-public' },
    encrypted_credentials: sealCredentials('org', 'cloudflare', { access_key_id: 'synthetic-customer-key', secret_access_key: 'synthetic-customer-secret' }),
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const mediaPath = (id: string) => `${paths.media('org', 'site')}/${id}`;
const readyStorage = (key: string) => ({ provider: 'organization_r2' as const, account_id: account, bucket: 'customer-private', key, generation: 'connected-revision', state: 'ready' as const, grant_expires_at: '' });

describe('extension policy', () => {
  it('accepts only extensions that belong to the media type', () => {
    for (const [name, type] of [['photo.jpg', 'image/jpeg'], ['PHOTO.JPEG', 'image/jpeg'], ['a.png', 'image/png; charset=binary'], ['logo.svg', 'image/SVG+xml'],
      ['doc.pdf', 'application/pdf'], ['/archive/2023/photo.webp', 'image/webp'], ['icon.ico', 'image/x-icon']] as const) {
      expect(mediaNameMatchesType(name, type), `${name} ${type}`).toBe(true);
    }
    for (const [name, type] of [['x.html', 'image/png'], ['x.svg', 'image/png'], ['x.xml', 'image/svg+xml'], ['x.xhtml', 'image/svg+xml'], ['x.js', 'image/jpeg'],
      ['x.png.html', 'image/png'], ['/x.ht%6Dl', 'image/png'], ['/x.png%2Ehtml', 'image/png'], ['noextension', 'image/png'], ['x.', 'image/png'], ['x.pdf', 'image/png']] as const) {
      expect(mediaNameMatchesType(name, type), `${name} ${type}`).toBe(false);
    }
    expect(() => assertMediaName('x.html', 'image/png')).toThrow(expect.objectContaining({ status: 400, code: 'media_extension_mismatch' }));
    expect(() => assertMediaName('x.html', 'text/html')).toThrow(expect.objectContaining({ status: 415, code: 'media_type_unsupported' }));
    expect(() => assertMediaName('x.svg', 'image/x-icon+xml')).toThrow(expect.objectContaining({ code: 'media_type_unsupported' }));
    expect(withMediaExtension('download.php', 'image/png')).toBe('download.php.png');
    expect(withMediaExtension('photo.JPG', 'image/jpeg')).toBe('photo.JPG');
  });

  it('checks changed names only, so legacy records stay editable', () => {
    const legacy = { mime_type: 'image/png', filename: 'old.html', public_path: '/old.html' };
    expect(() => assertMediaNameUpdate(legacy, { filename: 'old.html', public_path: '/old.html', alt_text: 'x' })).not.toThrow();
    expect(() => assertMediaNameUpdate(legacy, { filename: 'new.html' })).toThrow(expect.objectContaining({ code: 'media_extension_mismatch' }));
    expect(() => assertMediaNameUpdate(legacy, { public_path: '/new.svg' })).toThrow(expect.objectContaining({ code: 'media_extension_mismatch' }));
    expect(() => assertMediaNameUpdate(legacy, { public_path: null, filename: 'fixed.png' })).not.toThrow();
  });
});

describe('routes that set media names', () => {
  async function call(module: Promise<Record<string, APIRoute | unknown>>, method: string, body: unknown, params: Record<string, string>, token?: string) {
    const handler = (await module)[method] as APIRoute;
    return handler({ request: new Request('https://cms.example.com/api', { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }),
      params, cookies: { get: () => undefined }, locals: {} } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
  }

  it.each([['cookie', 'contentType'], ['api', 'content_type']] as const)('appends the type extension to an upload whose filename does not match (%s)', async (surface, typeField) => {
    const { token } = await createApiKey({ orgId: 'org', siteId: 'site', name: 'test', createdBy: 'test' });
    const route = surface === 'api' ? import('../../pages/api/v1/sites/[siteId]/media/upload-url') : import('../../pages/api/sites/[siteId]/media/upload-url');
    for (const filename of ['x.html', 'x.svg', 'x.xml', 'payload.js', 'logo']) {
      const response = await call(route, 'POST', { filename, [typeField]: 'image/png', size: 3 }, { siteId: 'site' }, token);
      expect(response.status, filename).toBe(200);
      const data = await response.json();
      expect(data.filename ?? data.data?.filename, filename).toBe(`${filename}.png`);
    }
    const stored = await getStore().listDocs<Media>(paths.media('org', 'site'));
    expect(stored.map(item => item.filename).sort()).toEqual(['logo.png', 'payload.js.png', 'x.html.png', 'x.svg.png', 'x.xml.png']);
    expect(stored.every(item => item.storage?.key.endsWith('.png'))).toBe(true);
    const accepted = await call(route, 'POST', { filename: 'Photo.PNG', [typeField]: 'image/png', size: 3 }, { siteId: 'site' }, token);
    expect(accepted.status).toBe(200);
    expect((await getStore().listDocs<Media>(paths.media('org', 'site'))).some(item => item.filename === 'Photo.PNG')).toBe(true);
    // A type that cannot be published is still refused, and nothing is created.
    for (const type of ['image/x-unknown', 'text/html']) {
      const refused = await call(route, 'POST', { filename: 'x.png', [typeField]: type, size: 3 }, { siteId: 'site' }, token);
      expect(refused.status, type).toBe(415);
    }
    expect(await getStore().listDocs(paths.media('org', 'site'))).toHaveLength(6);
  });

  it.each([['cookie', 'contentType'], ['api', 'content_type']] as const)('appends the extension on the platform storage path too (%s)', async (surface, typeField) => {
    const { token } = await createApiKey({ orgId: 'org', siteId: 'site', name: 'test', createdBy: 'test' });
    await getStore().updateDoc(paths.site('org', 'site'), { publishing_mode: null });
    await getStore().updateDoc(connectionPath('org', 'cloudflare'), { status: 'disconnected', media_ready: false, encrypted_credentials: null });
    const route = surface === 'api' ? import('../../pages/api/v1/sites/[siteId]/media/upload-url') : import('../../pages/api/sites/[siteId]/media/upload-url');
    const response = await call(route, 'POST', { filename: 'x.html', [typeField]: 'image/png', size: 3 }, { siteId: 'site' }, token);
    expect(response.status).toBe(200);
    const [record] = await getStore().listDocs<Media>(paths.media('org', 'site'));
    expect(record).toMatchObject({ filename: 'x.html.png', mime_type: 'image/png', r2_key: expect.stringMatching(/-x\.html\.png$/) });
    const data = await response.json();
    expect(data.filename).toBe('x.html.png');
    expect(new URL(data.upload_url ?? data.uploadUrl).pathname).toMatch(/\.png$/);
    const refused = await call(route, 'POST', { filename: 'x.png', [typeField]: 'image/x-unknown', size: 3 }, { siteId: 'site' }, token);
    expect(refused.status).toBe(415);
  });

  it.each(['cookie', 'api'] as const)('refuses renaming a filename or public_path to an executable extension (%s)', async surface => {
    const { token } = await createApiKey({ orgId: 'org', siteId: 'site', name: 'test', createdBy: 'test' });
    await getStore().setDoc(mediaPath('m1'), { filename: 'legacy.html', mime_type: 'image/png', cdn_url: 'https://cms.example.com/x', created_at: '' });
    const route = surface === 'api' ? import('../../pages/api/v1/sites/[siteId]/media/[mediaId]') : import('../../pages/api/sites/[siteId]/media/[mediaId]');
    const method = surface === 'api' ? 'PATCH' : 'PUT';
    for (const body of [{ public_path: '/evil.html' }, { public_path: '/evil.svg' }, { public_path: '/evil.ht%6Dl' }, { filename: 'evil.xhtml' }, { filename: 'evil.js' }]) {
      const response = await call(route, method, body, { siteId: 'site', mediaId: 'm1' }, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await getStore().getDoc<Media>(mediaPath('m1'))).toMatchObject({ filename: 'legacy.html' });
    expect((await getStore().getDoc<Media>(mediaPath('m1')))?.public_path).toBeUndefined();
    // Saving other fields with the unchanged legacy name still works.
    expect((await call(route, method, { filename: 'legacy.html', alt_text: 'Alt' }, { siteId: 'site', mediaId: 'm1' }, token)).status).toBe(200);
    expect((await call(route, method, { public_path: '/photos/a.png', filename: 'a.png' }, { siteId: 'site', mediaId: 'm1' }, token)).status).toBe(200);
    expect(await getStore().getDoc<Media>(mediaPath('m1'))).toMatchObject({ filename: 'a.png', public_path: '/photos/a.png', alt_text: 'Alt' });
  });

  it('appends the type extension to a chosen or derived import filename', async () => {
    vi.mocked(copyWithTransferService).mockReset().mockImplementation(async input => {
      const body = Buffer.from('png'), etag = '"worker"';
      objects.set(`${input.bucket}/${input.key}`, { body, etag });
      return { protocol: 1, id: 'synthetic', sha256: sha(body), size: body.length, etag };
    });
    const transfer = new WPMediaTransfer('org', 'site', getStore());
    const chosen = await transfer.importUrl('https://source.example.com/a', { filename: 'x.html', contentType: 'image/png' });
    expect((await getStore().getDoc<Media>(mediaPath(chosen.mediaId)))?.filename).toBe('x.html.png');
    const imported = await transfer.importUrl('https://source.example.com/render.php', { contentType: 'image/png' });
    expect((await getStore().getDoc<Media>(mediaPath(imported.mediaId)))?.filename).toBe('render.php.png');
  });

  it('createMediaUpload stores a matching name for every caller', async () => {
    const html = await createMediaUpload('org', 'site', { filename: 'x.html', contentType: 'image/png', size: 3, actor: 'test' });
    expect(html).toMatchObject({ filename: 'x.html.png', key: expect.stringMatching(/\/x\.html\.png$/) });
    expect(await getStore().getDoc<Media>(mediaPath(html.mediaId))).toMatchObject({ filename: 'x.html.png', mime_type: 'image/png' });
    expect((await createMediaUpload('org', 'site', { filename: 'x.svg', contentType: 'image/jpeg', size: 3, actor: 'test' })).filename).toBe('x.svg.jpg');
    expect((await createMediaUpload('org', 'site', { filename: 'x.jpeg', contentType: 'image/jpeg', size: 3, actor: 'test' })).filename).toBe('x.jpeg');
    await expect(createMediaUpload('org', 'site', { filename: 'x.png', contentType: 'image/x-unknown', size: 3, actor: 'test' })).rejects.toMatchObject({ status: 415 });
  });
});

describe('finalizeStoredMedia', () => {
  it('cannot freeze an SVG that was not sanitized', async () => {
    const created = await createMediaUpload('org', 'site', { filename: 'logo.svg', contentType: 'image/svg+xml', size: MALICIOUS.length, actor: 'test' });
    objects.set(`customer-private/${created.key}`, { body: MALICIOUS, etag: '"client-put"' });
    await expect(finalizeStoredMedia('org', 'site', created.mediaId)).rejects.toMatchObject({ status: 409, code: 'media_svg_unsanitized' });
    // A marker for other bytes does not count either.
    await getStore().updateDoc(mediaPath(created.mediaId), { svg_sanitized: { source_sha256: sha(MALICIOUS), sha256: 'f'.repeat(64), removed: [] } });
    await expect(finalizeStoredMedia('org', 'site', created.mediaId)).rejects.toMatchObject({ code: 'media_svg_unsanitized' });
    expect((await getStore().getDoc<Media>(mediaPath(created.mediaId)))?.storage?.state).toBe('uploading');
    const png = await createMediaUpload('org', 'site', { filename: 'a.png', contentType: 'image/png', size: 3, actor: 'test' });
    objects.set(`customer-private/${png.key}`, { body: Buffer.from('png'), etag: '"put"' });
    await expect(finalizeStoredMedia('org', 'site', png.mediaId)).resolves.toMatchObject({ sha256: sha('png') });
  });
});

describe('publication media manifest', () => {
  beforeEach(async () => {
    const config = await getOrganizationDomains('org');
    await saveOrganizationDomains('org', { revision: config.revision, sites_domain: 'demos.example.com', media_host: 'media.example.net', dns_mode: 'external' });
  });
  async function seed(id: string, doc: Partial<SvgMedia>, body: Buffer = Buffer.from(id)) {
    const digest = sha(body), key = `private/media/abcdefghij/originals/${digest}/${doc.filename}`;
    objects.set(`customer-private/${key}`, { body, etag: `"${id}"` });
    await getStore().setDoc(mediaPath(id), { cdn_url: `https://cms.example.com/api/sites/site/media/${id}/content`, sha256: digest, size_bytes: body.length,
      storage: readyStorage(key), created_at: '', ...doc });
    return `https://cms.example.com/api/sites/site/media/${id}/content`;
  }

  it('publishes a mismatched legacy name under the type extension and rewrites references', async () => {
    const byPath = await seed('a', { filename: 'a.png', mime_type: 'image/png', public_path: '/evil.html' });
    const byName = await seed('b', { filename: 'evil.html', mime_type: 'image/png' });
    const unknown = await seed('c', { filename: 'run.js', mime_type: 'text/javascript' });
    const result = await publicationMediaManifest('org', 'site', { html: `<img src="${byPath}"><img src="${byName}"><a href="${unknown}">x</a>` }, 'site.demos.example.com');
    const paths_ = result.manifest!.entries.map(entry => entry.public_path);
    expect(paths_).toContain('/media/evil.html.png');
    expect(paths_.find(path => path.includes('evil.html-') || path.endsWith('-evil.html.png'))).toMatch(/-evil\.html\.png$/);
    expect(result.manifest!.entries.find(entry => entry.id === 'c')).toMatchObject({ mime_type: 'application/octet-stream', public_path: expect.stringMatching(/-run\.js\.bin$/) });
    expect(result.manifest!.entries.every(entry => !/\.(?:html|js)$/.test(entry.public_path))).toBe(true);
    expect(result.content.html).not.toContain('evil.html"');
    expect(result.warnings).toHaveLength(3);
  });

  it('keeps passive names unchanged and infers a missing type from them', () => {
    expect(publishableMediaPath('/a/photo.JPG', 'image/jpeg')).toEqual({ path: '/a/photo.JPG', mime_type: 'image/jpeg', renamed: false });
    expect(publishableMediaPath('/a/photo.png', undefined)).toEqual({ path: '/a/photo.png', mime_type: 'image/png', renamed: false });
    expect(publishableMediaPath('/a/logo.svg', undefined)).toMatchObject({ path: '/a/logo.svg.bin', mime_type: 'application/octet-stream' });
  });

  it('sanitizes a legacy SVG before it is published', async () => {
    const url = await seed('svg', { filename: 'logo.svg', mime_type: 'image/svg+xml' }, MALICIOUS);
    const result = await publicationMediaManifest('org', 'site', { html: `<img src="${url}">` }, 'site.demos.example.com');
    const entry = result.manifest!.entries[0];
    expect(entry).toMatchObject({ mime_type: 'image/svg+xml', svg_sanitized: true });
    expect(entry.sha256).not.toBe(sha(MALICIOUS));
    const stored = objects.get(`customer-private/${entry.source_key}`)!.body.toString();
    expect(sha(stored)).toBe(entry.sha256);
    expect(stored).not.toMatch(/script|onload/);
    expect((await getStore().getDoc<SvgMedia>(mediaPath('svg')))?.svg_sanitized?.sha256).toBe(entry.sha256);
  });

  it('leaves out an SVG that cannot be sanitized, keeps publishing the rest and warns', async () => {
    const bad = await seed('bad', { filename: 'bad.svg', mime_type: 'image/svg+xml' }, NOT_SVG);
    const photo = await seed('photo', { filename: 'photo.png', mime_type: 'image/png' });
    const result = await publicationMediaManifest('org', 'site', { html: `<img src="${bad}"><img src="${photo}">` }, 'site.demos.example.com');
    expect(result.manifest!.entries.map(entry => entry.id)).toEqual(['photo']);
    expect(result.sourceMedia.map(item => item.id)).toEqual(['photo']);
    // No private address and no bytes of the excluded file reach the publication.
    expect(result.content.html).toMatch(/^<img src=""><img src="https:\/\/site\.demos\.example\.com\/media\/[^"]+photo\.png">$/);
    expect(result.warnings).toEqual([expect.stringMatching(/^Media bad \(bad\.svg\) was not published: the SVG could not be made safe/)]);
    expect((await getStore().getDoc<SvgMedia>(mediaPath('bad')))?.svg_sanitized).toBeUndefined();
  });

  it('checks legacy SVGs in a dry run without writing records or objects', async () => {
    const url = await seed('svg', { filename: 'logo.svg', mime_type: 'image/svg+xml' }, MALICIOUS);
    const bad = await seed('bad', { filename: 'bad.svg', mime_type: 'image/svg+xml' }, NOT_SVG);
    const before = await getStore().getDoc<SvgMedia>(mediaPath('svg'));
    const result = await publicationMediaManifest('org', 'site', { html: `<img src="${url}"><img src="${bad}">` }, 'site.demos.example.com', undefined, { dryRun: true });
    expect(result.manifest!.entries.map(entry => entry.id)).toEqual(['svg']);
    expect(result.warnings).toHaveLength(1);
    expect(await getStore().getDoc<SvgMedia>(mediaPath('svg'))).toEqual(before);
    expect(vi.mocked(S3Client.prototype.send).mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('refuses a domain change of a publication with an unsanitized SVG and says how to fix it', async () => {
    const url = await seed('svg', { filename: 'logo.svg', mime_type: 'image/svg+xml' }, MALICIOUS);
    const first = await publicationMediaManifest('org', 'site', { html: `<img src="${url}">` }, 'site.demos.example.com');
    // A publication made before sanitizing existed: the unsanitized bytes, without the flag.
    const legacy = { ...first.manifest!, entries: first.manifest!.entries.map(({ svg_sanitized: _flag, ...entry }) => ({ ...entry, sha256: sha(MALICIOUS) })) };
    await expect(publicationMediaManifest('org', 'site', first.content, 'site.demos.example.com', { site_url: 'https://site.demos.example.com', media_manifest: legacy }))
      .rejects.toMatchObject({ status: 409, code: 'media_svg_unsanitized', message: expect.stringContaining('Publish the site once before changing domains') });
    await expect(publicationMediaManifest('org', 'site', first.content, 'site.demos.example.com', { site_url: 'https://site.demos.example.com', media_manifest: first.manifest }))
      .resolves.toMatchObject({ manifest: { entries: [expect.objectContaining({ id: 'svg', svg_sanitized: true })] } });
  });

  it('does not serve unsafe entries of older manifests again', () => {
    const manifest = (entries: unknown[]) => ({ account_id: 'account', original_bucket: 'private', public_bucket: 'public', site_prefix: 'media', delivery: 'static',
      media_host: 'site.example.test', website_host: 'site.example.test', media_path_prefix: '/media', entries });
    const entry = (id: string, public_path: string, mime_type: string, extra = {}) => ({ id, source_key: `private/media/originals/${id}`, sha256: id.padStart(64, '0'),
      public_key: `media${public_path}`, public_path, mime_type, aliases: [], ...extra });
    const old = manifest([entry('1', '/media/x.html', 'image/png'), entry('2', '/media/logo.svg', 'image/svg+xml'), entry('3', '/media/ok.svg', 'image/svg+xml', { svg_sanitized: true }), entry('4', '/media/ok.png', 'image/png')]);
    const retained = retainDistinctMediaManifests([old], null);
    expect(retained[0].entries.map((item: { id: string }) => item.id)).toEqual(['3', '4']);
  });
});

describe('storage migration', () => {
  it('stores a migrated SVG only in sanitized form', async () => {
    const id = 'svg';
    await getStore().setDoc(mediaPath(id), { filename: 'logo.svg', mime_type: 'image/svg+xml', cdn_url: 'https://cdn.example.com/old/logo.svg', r2_key: 'original', sha256: sha(MALICIOUS),
      size_bytes: MALICIOUS.length, created_at: '', storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: 'original', state: 'ready', generation: 'draft', grant_expires_at: '' } });
    vi.mocked(copyWithTransferService).mockReset().mockImplementation(async input => {
      const etag = '"worker"';
      objects.set(`${input.bucket}/${input.key}`, { body: MALICIOUS, etag });
      return { protocol: 1, id: 'synthetic', sha256: sha(MALICIOUS), size: MALICIOUS.length, etag };
    });
    await requestMediaMigration('org'); await runMediaMigrationBatch('org');
    const saved = await getStore().getDoc<SvgMedia>(mediaPath(id));
    expect(saved?.storage).toMatchObject({ provider: 'organization_r2', state: 'ready' });
    const stored = objects.get(`customer-private/${saved!.storage!.key}`)!;
    expect(stored.body.toString()).not.toMatch(/script|onload/);
    expect(stored.contentType).toBe('image/svg+xml');
    expect(saved).toMatchObject({ sha256: sha(stored.body), size_bytes: stored.body.length, mime_type: 'image/svg+xml',
      svg_sanitized: { source_sha256: sha(MALICIOUS), sha256: sha(stored.body) } });
    expect(saved!.storage!.key).toContain(`/originals/${sha(stored.body)}/`);
  });

  it('keeps an SVG that cannot be sanitized private and unmarked', async () => {
    await getStore().setDoc(mediaPath('bad'), { filename: 'bad.svg', mime_type: 'image/svg+xml', cdn_url: 'https://cdn.example.com/old/bad.svg', r2_key: 'original', sha256: sha(NOT_SVG),
      size_bytes: NOT_SVG.length, created_at: '', storage: { provider: 'draft_r2', account_id: 'b'.repeat(32), bucket: 'private-drafts', key: 'original', state: 'ready', generation: 'draft', grant_expires_at: '' } });
    vi.mocked(copyWithTransferService).mockReset().mockImplementation(async input => {
      objects.set(`${input.bucket}/${input.key}`, { body: NOT_SVG, etag: '"worker"' });
      return { protocol: 1, id: 'synthetic', sha256: sha(NOT_SVG), size: NOT_SVG.length, etag: '"worker"' };
    });
    await requestMediaMigration('org'); await runMediaMigrationBatch('org');
    const saved = await getStore().getDoc<SvgMedia>(mediaPath('bad'));
    expect(saved?.storage?.provider).toBe('organization_r2');
    expect(saved?.svg_sanitized).toBeUndefined();
  });
});

describe('client finalize helper', () => {
  it('removes a refused upload and reports why', async () => {
    const calls: Array<[string, string]> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? 'GET', url]);
      if (url.endsWith('/finalize')) return new Response(JSON.stringify({ error: 'The SVG was rejected: not an SVG.', code: 'media_svg_invalid' }), { status: 400 });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const error = await finalizeUpload('site', { finalizeUrl: '/api/sites/site/media/m1/finalize' }, fetchImpl).catch(caught => caught);
    expect(error).toBeInstanceOf(MediaFinalizeError);
    expect(error).toMatchObject({ code: 'media_svg_invalid', removed: true, message: expect.stringContaining('The SVG was rejected') });
    expect(calls).toEqual([['POST', '/api/sites/site/media/m1/finalize'], ['DELETE', '/api/sites/site/media/m1']]);
  });

  it('keeps the record for errors that are not about the file', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [400, 'invalid_request'], [409, 'media_storage_unavailable']] as const) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'No.', code }), { status })) as unknown as typeof fetch;
      await expect(finalizeUpload('site', { finalizeUrl: '/f', mediaId: 'm1' }, fetchImpl, async () => {})).rejects.toMatchObject({ removed: false, status });
      expect(fetchImpl, String(status)).toHaveBeenCalledTimes(1);
    }
  });

  it.each([[400, 'media_extension_mismatch'], [415, 'media_type_unsupported'], [422, 'media_svg_truncated'], [422, 'media_integrity_failed']] as const)('removes the record for a refused file (%s %s)', async (status, code) => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Response('{}', { status: 200 }) : new Response(JSON.stringify({ error: 'Refused.', code }), { status })) as unknown as typeof fetch;
    await expect(finalizeUpload('site', { finalizeUrl: '/f', mediaId: 'm1' }, fetchImpl, async () => {})).rejects.toMatchObject({ removed: true, status, code });
  });

  it('retries a revision conflict or rate limit instead of deleting the upload', async () => {
    const sleep = vi.fn(async () => {});
    const responses = [new Response(JSON.stringify({ error: 'Changed.', code: 'media_revision_conflict' }), { status: 409 }),
      new Response(JSON.stringify({ error: 'Slow down.' }), { status: 429 }), new Response(JSON.stringify({ ok: true, result: { sha256: 'x' } }), { status: 200 })];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    await expect(finalizeUpload('site', { finalizeUrl: '/f', mediaId: 'm1' }, fetchImpl, sleep)).resolves.toEqual({ sha256: 'x' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const conflict = vi.fn(async () => new Response(JSON.stringify({ error: 'Changed.', code: 'media_revision_conflict' }), { status: 409 })) as unknown as typeof fetch;
    await expect(finalizeUpload('site', { finalizeUrl: '/f', mediaId: 'm1' }, conflict, async () => {})).rejects.toMatchObject({ removed: false, status: 409 });
    expect(vi.mocked(conflict).mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
  });

  it('keeps the record on a server error but still reports it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Storage unavailable.' }), { status: 503 })) as unknown as typeof fetch;
    await expect(finalizeUpload('site', { finalizeUrl: '/api/sites/site/media/m1/finalize', mediaId: 'm1' }, fetchImpl)).rejects.toMatchObject({ removed: false, status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { sha256: 'x' } }), { status: 200 })) as unknown as typeof fetch;
    await expect(finalizeUpload('site', { finalizeUrl: '/f' }, ok)).resolves.toEqual({ sha256: 'x' });
  });
});
