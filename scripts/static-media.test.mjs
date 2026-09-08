import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareMedia } from './fixtures/static-publication/media.mjs';

test('customer build copies verified media to static output, preserves aliases and rejects changed immutable bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-media-'));
  const fetchBefore = globalThis.fetch;
  const envBefore = process.env.TYPEROLL_BUILD_MEDIA_ACCESS;
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#1374aa' } }).png().toBuffer();
  const account = 'a'.repeat(32), prefix = 'media/abcdefghij';
  const originalKey = `private/${prefix}/originals/image.png`;
  const publicKey = `${prefix}/image.png`, aliasKey = `${prefix}/shared.png`;
  const origin = `https://${account}.r2.cloudflarestorage.com`;
  const stored = new Map([[originalKey, original]]);
  const entry = { id: 'image', source_key: originalKey, public_key: publicKey, public_path: '/image.png', mime_type: 'image/png',
    cdn_url: 'https://images.example.com/image.png', sha256: sha(original), size_bytes: original.length,
    aliases: [{ url: 'https://media.example.com/shared.png', key: aliasKey }] };
  const objects = {};
  for (const key of [publicKey, aliasKey]) for (const suffix of ['', `.v1.w320.${entry.sha256.slice(0, 16)}.webp`, `.v1.w320.${entry.sha256.slice(0, 16)}.avif`]) {
    objects[key + suffix] = { get: `${origin}/${key + suffix}`, put: `${origin}/${key + suffix}`, headers: {} };
  }
  const grants = Buffer.from(JSON.stringify({ publication_id: 'frozen', expires_at: Date.now() + 60_000,
    account_id: account, original_bucket: 'private', public_bucket: 'public', originals: { [originalKey]: `${origin}/${originalKey}` }, objects }));
  const publication = { publication_id: 'frozen', media: [{ id: 'image' }], media_manifest: { delivery: 'static', account_id: account, original_bucket: 'private', public_bucket: 'public',
    site_prefix: prefix, website_host: 'www.example.com', media_host: 'images.example.com', entries: [entry] } };
  process.env.TYPEROLL_BUILD_MEDIA_ACCESS = JSON.stringify({ grant_url: `${origin}/grant`, sha256: sha(grants) });
  globalThis.fetch = async (address, options = {}) => {
    assert.equal(new URL(address).origin, origin);
    const key = new URL(address).pathname.slice(1);
    if (key === 'grant') return new Response(grants);
    if (options.method === 'PUT') { if (stored.has(key)) return new Response(null, { status: 412 }); stored.set(key, Buffer.from(options.body)); return new Response(null); }
    return stored.has(key) ? new Response(stored.get(key)) : new Response(null, { status: 404 });
  };
  try {
    const files = await prepareMedia(publication, root);
    assert.equal(files.length, 3);
    assert.equal(sha(await fs.readFile(path.join(root, '.publication-media/image.png'))), entry.sha256);
    assert.equal(publication.media[0].variants.length, 2);
    assert.equal(sha(stored.get(aliasKey)), entry.sha256);
    assert.equal(files.some(file => file.path.includes('private') || file.path.includes('shared')), false);
    // Rebuilding retained + current references is allowed only for identical assets.
    publication.retained_media_manifests = [publication.media_manifest];
    assert.equal((await prepareMedia(publication, root)).length, 6);
    stored.set(publicKey, Buffer.from('different immutable contents'));
    await assert.rejects(() => prepareMedia(publication, root), /different bytes/);
  } finally {
    globalThis.fetch = fetchBefore;
    if (envBefore === undefined) delete process.env.TYPEROLL_BUILD_MEDIA_ACCESS;
    else process.env.TYPEROLL_BUILD_MEDIA_ACCESS = envBefore;
    await fs.rm(root, { recursive: true, force: true });
  }
});
