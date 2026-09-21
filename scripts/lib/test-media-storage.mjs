import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { mediaReceiptKey } from '../fixtures/static-publication/media-receipt.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function withMediaFixture(run, count = 1, completion = false, sourceWidth = 640) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-media-'));
  const fetchBefore = globalThis.fetch, envBefore = process.env.TYPEROLL_BUILD_MEDIA_ACCESS;
  const original = count === 1 ? await sharp({ create: { width: sourceWidth, height: Math.round(sourceWidth * 0.75), channels: 3, background: '#1374aa' } }).png().toBuffer() : Buffer.from('synthetic document');
  const account = 'a'.repeat(32), prefix = 'media/abcdefghij', origin = `https://${account}.r2.cloudflarestorage.com`;
  const stored = new Map(), objects = {}, prepared = {}, originals = {}, entries = [], writes = new Map();
  for (let i = 0; i < count; i++) {
    const publicKey = `${prefix}/image-${i}.png`, sourceKey = `private/${prefix}/originals/image-${i}.png`, aliasKey = `${prefix}/shared-${i}.png`;
    stored.set(sourceKey, original); originals[sourceKey] = `${origin}/${sourceKey}`;
    const entry = { id: `image-${i}`, source_key: sourceKey, public_key: publicKey, public_path: `/image-${i}.png`, mime_type: count === 1 ? 'image/png' : 'application/octet-stream',
      cdn_url: `https://images.example.com/image-${i}.png`, sha256: sha(original), size_bytes: original.length, aliases: [{ url: `https://media.example.com/shared-${i}.png`, key: aliasKey }] };
    entries.push(entry);
    if (count === 1) for (const width of [320, 640, 1024, 1920, 'original']) for (const format of ['webp', 'avif']) for (const tail of ['', '.receipt.json']) {
      const key = `private/${prefix}/prepared/v2/${entry.sha256}/${width === 'original' ? 'original' : 'w' + width}.${format}${tail}`;
      prepared[key] = { get: `${origin}/${key}`, put: `${origin}/${key}`, headers: {} };
    }
    const suffixes = [''];
    if (count === 1) for (const width of [320, 640, 1024, 1920, 'original']) for (const format of ['webp', 'avif']) { const suffix = `.v2.${width === 'original' ? 'original' : 'w' + width}.${entry.sha256.slice(0, 16)}.${format}`; suffixes.push(suffix, suffix + '.receipt.json'); }
    for (const key of [publicKey, aliasKey]) for (const suffix of suffixes) objects[key + suffix] = { get: `${origin}/${key + suffix}`, put: `${origin}/${key + suffix}`, headers: {} };
  }
  const publication = { publication_id: 'frozen', media: entries.map(entry => ({ id: entry.id })), media_manifest: { delivery: 'static', account_id: account, original_bucket: 'private', public_bucket: 'public', site_prefix: prefix, website_host: 'www.example.com', media_host: 'images.example.com', entries } };
  if (completion) for (const entry of entries) { const key = mediaReceiptKey(publication.media_manifest, entry); objects[key] = { get: `${origin}/${key}`, put: `${origin}/${key}`, headers: {} }; }
  const grants = Buffer.from(JSON.stringify({ publication_id: 'frozen', expires_at: Date.now() + 60_000, account_id: account, original_bucket: 'private', public_bucket: 'public', originals, objects, prepared }));
  process.env.TYPEROLL_BUILD_MEDIA_ACCESS = JSON.stringify({ grant_url: `${origin}/grant`, sha256: sha(grants) });
  globalThis.fetch = async (address, options = {}) => {
    assert.equal(new URL(address).origin, origin);
    const key = new URL(address).pathname.slice(1);
    if (key === 'grant') return new Response(grants);
    if (options.method === 'PUT') { if (stored.has(key)) return new Response(null, { status: 412 }); stored.set(key, Buffer.from(options.body)); writes.set(key, (writes.get(key) ?? 0) + 1); return new Response(null); }
    return stored.has(key) ? new Response(stored.get(key)) : new Response(null, { status: 404 });
  };
  try { await run({ publication, stored, writes, root, entries }); }
  finally {
    globalThis.fetch = fetchBefore;
    if (envBefore === undefined) delete process.env.TYPEROLL_BUILD_MEDIA_ACCESS; else process.env.TYPEROLL_BUILD_MEDIA_ACCESS = envBefore;
    await fs.rm(root, { recursive: true, force: true });
  }
}
