import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareMedia, prepareMediaBatch } from './fixtures/static-publication/media.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function withMediaFixture(run, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-media-'));
  const fetchBefore = globalThis.fetch, envBefore = process.env.TYPEROLL_BUILD_MEDIA_ACCESS;
  const original = count === 1 ? await sharp({ create: { width: 640, height: 480, channels: 3, background: '#1374aa' } }).png().toBuffer() : Buffer.from('synthetic document');
  const account = 'a'.repeat(32), prefix = 'media/abcdefghij', origin = `https://${account}.r2.cloudflarestorage.com`;
  const stored = new Map(), objects = {}, originals = {}, entries = [], writes = new Map();
  for (let i = 0; i < count; i++) {
    const publicKey = `${prefix}/image-${i}.png`, sourceKey = `private/${prefix}/originals/image-${i}.png`, aliasKey = `${prefix}/shared-${i}.png`;
    stored.set(sourceKey, original); originals[sourceKey] = `${origin}/${sourceKey}`;
    const entry = { id: `image-${i}`, source_key: sourceKey, public_key: publicKey, public_path: `/image-${i}.png`, mime_type: count === 1 ? 'image/png' : 'application/octet-stream',
      cdn_url: `https://images.example.com/image-${i}.png`, sha256: sha(original), size_bytes: original.length, aliases: [{ url: `https://media.example.com/shared-${i}.png`, key: aliasKey }] };
    entries.push(entry);
    const suffixes = [''];
    if (count === 1) for (const format of ['webp', 'avif']) { const suffix = `.v1.w320.${entry.sha256.slice(0, 16)}.${format}`; suffixes.push(suffix, suffix + '.receipt.json'); }
    for (const key of [publicKey, aliasKey]) for (const suffix of suffixes) objects[key + suffix] = { get: `${origin}/${key + suffix}`, put: `${origin}/${key + suffix}`, headers: {} };
  }
  const grants = Buffer.from(JSON.stringify({ publication_id: 'frozen', expires_at: Date.now() + 60_000, account_id: account, original_bucket: 'private', public_bucket: 'public', originals, objects }));
  const publication = { publication_id: 'frozen', media: entries.map(entry => ({ id: entry.id })), media_manifest: { delivery: 'static', account_id: account, original_bucket: 'private', public_bucket: 'public', site_prefix: prefix, website_host: 'www.example.com', media_host: 'images.example.com', entries } };
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

test('copies verified static media, preserves aliases and rejects changed immutable bytes', async () => withMediaFixture(async ({ publication, root, stored, entries: [entry] }) => {
  const files = await prepareMedia(publication, root);
  assert.equal(files.length, 3);
  assert.equal(sha(await fs.readFile(path.join(root, '.publication-media/image-0.png'))), entry.sha256);
  assert.equal(publication.media[0].variants.length, 2);
  assert.equal(sha(stored.get(entry.aliases[0].key)), entry.sha256);
  assert.equal(files.some(file => /private|shared|receipt/.test(file.path)), false);
  publication.retained_media_manifests = [publication.media_manifest];
  assert.equal((await prepareMedia(publication, root)).length, 6);
  stored.set(entry.public_key, Buffer.from('different immutable contents'));
  await assert.rejects(() => prepareMedia(publication, root), /different bytes/);
}));

test('resumes a process interruption without encoding finished variants again and verifies their bytes', async t => withMediaFixture(async ({ publication, root, stored, entries: [entry] }) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('.avif') && options?.method === 'PUT') throw new Error('simulated network interruption');
    return originalFetch(url, options);
  };
  await assert.rejects(() => prepareMediaBatch(publication, root), /media_transfer_interrupted/);
  globalThis.fetch = originalFetch;
  // The next process has a fresh filesystem and no local state.
  await fs.rm(path.join(root, '.publication-media'), { recursive: true, force: true });
  const encode = sharp.prototype.toBuffer; let encoded = 0;
  t.mock.method(sharp.prototype, 'toBuffer', function (...args) { encoded++; return encode.apply(this, args); });
  assert.deepEqual(await prepareMediaBatch(publication, root), { cursor: 1, total: 1 });
  assert.equal(encoded, 1, 'only the unfinished AVIF needs encoding');
  encoded = 0;
  await prepareMedia(publication, root);
  assert.equal(encoded, 0, 'the final static build reuses verified encodings');
  const variantKey = entry.public_key + `.v1.w320.${entry.sha256.slice(0, 16)}.webp`;
  stored.set(variantKey, Buffer.from('tampered variant'));
  await assert.rejects(() => prepareMedia(publication, root), /byte verification/);
}));

test('prepares 1001 files in bounded batches, resumes the exact cursor and packages every static file', async () => withMediaFixture(async ({ publication, root, writes }) => {
  let cursor = 0, batches = 0;
  while (cursor < 1001) {
    const progress = await prepareMediaBatch(publication, root, cursor);
    assert.equal(progress.total, 1001);
    assert.ok(progress.cursor > cursor && progress.cursor <= cursor + 100);
    cursor = progress.cursor; batches++;
    assert.equal(await fs.stat(path.join(root, '.publication-media')).then(() => true, () => false), false);
  }
  assert.equal(batches, 11);
  assert.equal((await prepareMedia(publication, root)).length, 1001);
  assert.ok([...writes.values()].every(count => count === 1));
  assert.equal(writes.size, 2002, 'one original and one shared alias per file');
  await assert.rejects(() => prepareMediaBatch(publication, root, 1002), /cursor/);
}, 1001));

test('a time budget yields after a completed file and retains old-version manifests in cursor order', async () => withMediaFixture(async ({ publication, root }) => {
  publication.retained_media_manifests = [publication.media_manifest];
  let now = 0;
  const progress = await prepareMediaBatch(publication, root, 0, { budgetMs: 1, clock: () => now++ });
  assert.deepEqual(progress, { cursor: 1, total: 2 });
  assert.deepEqual(await prepareMediaBatch(publication, root, 1), { cursor: 2, total: 2 });
  assert.equal((await prepareMedia(publication, root)).length, 6);
}));

test('retries an interrupted response body and does not retry denied access', async () => withMediaFixture(async ({ publication, root, entries: [entry] }) => {
  const originalFetch = globalThis.fetch; let reads = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith(entry.source_key) && ++reads === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error('connection closed')); } }));
    return originalFetch(url, options);
  };
  await prepareMedia(publication, root);
  assert.equal(reads, 2);
  reads = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith(entry.source_key)) { reads++; return new Response(null, { status: 403 }); }
    return originalFetch(url, options);
  };
  await assert.rejects(() => prepareMedia(publication, root), /publication access/);
  assert.equal(reads, 1);
}));

test('materializes cached files with bounded parallel reads while preparation remains sequential', async () => withMediaFixture(async ({ publication, root }) => {
  const originalFetch = globalThis.fetch; let active = 0, peak = 0;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname.startsWith('/private/')) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
    }
    return originalFetch(url, options);
  };
  await prepareMediaBatch(publication, root);
  assert.equal(peak, 1);
  peak = 0;
  assert.equal((await prepareMedia(publication, root)).length, 8);
  assert.ok(peak > 1 && peak <= 4);
  assert.equal(active, 0);
}, 8));
