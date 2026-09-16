import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareMedia, prepareMediaBatch, mediaTransferGroupSize } from './fixtures/static-publication/media.mjs';
import { mediaReceiptKey } from './fixtures/static-publication/media-receipt.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function withMediaFixture(run, count = 1, completion = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-media-'));
  const fetchBefore = globalThis.fetch, envBefore = process.env.TYPEROLL_BUILD_MEDIA_ACCESS;
  const original = count === 1 ? await sharp({ create: { width: 640, height: 480, channels: 3, background: '#1374aa' } }).png().toBuffer() : Buffer.from('synthetic document');
  const account = 'a'.repeat(32), prefix = 'media/abcdefghij', origin = `https://${account}.r2.cloudflarestorage.com`;
  const stored = new Map(), objects = {}, prepared = {}, originals = {}, entries = [], writes = new Map();
  for (let i = 0; i < count; i++) {
    const publicKey = `${prefix}/image-${i}.png`, sourceKey = `private/${prefix}/originals/image-${i}.png`, aliasKey = `${prefix}/shared-${i}.png`;
    stored.set(sourceKey, original); originals[sourceKey] = `${origin}/${sourceKey}`;
    const entry = { id: `image-${i}`, source_key: sourceKey, public_key: publicKey, public_path: `/image-${i}.png`, mime_type: count === 1 ? 'image/png' : 'application/octet-stream',
      cdn_url: `https://images.example.com/image-${i}.png`, sha256: sha(original), size_bytes: original.length, aliases: [{ url: `https://media.example.com/shared-${i}.png`, key: aliasKey }] };
    entries.push(entry);
    if (count === 1) for (const format of ['webp', 'avif']) for (const tail of ['', '.receipt.json']) {
      const key = `private/${prefix}/prepared/v1/${entry.sha256}/320.${format}${tail}`;
      prepared[key] = { get: `${origin}/${key}`, put: `${origin}/${key}`, headers: {} };
    }
    const suffixes = [''];
    if (count === 1) for (const format of ['webp', 'avif']) { const suffix = `.v1.w320.${entry.sha256.slice(0, 16)}.${format}`; suffixes.push(suffix, suffix + '.receipt.json'); }
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

test('unchanged publication reads one completion receipt and downloads each required artifact only once', async t => withMediaFixture(async ({ publication, root, entries: [entry] }) => {
  await prepareMediaBatch(publication, root);
  const fetchBefore = globalThis.fetch, reads = [];
  globalThis.fetch = (url, options) => { assert.notEqual(options?.method, 'PUT'); reads.push(new URL(url).pathname.slice(1)); return fetchBefore(url, options); };
  t.mock.method(sharp.prototype, 'metadata', () => { throw Error('unchanged images need no inspection'); });
  t.mock.method(sharp.prototype, 'toBuffer', () => { throw Error('unchanged images need no encoding'); });
  await prepareMediaBatch(publication, root);
  assert.deepEqual(reads, ['grant', mediaReceiptKey(publication.media_manifest, entry)]);
  reads.length = 0;
  const result = await prepareMediaBatch(publication, root, 0, { materialize: true });
  assert.equal(result.files.length, 3);
  assert.equal(reads.length, 5, 'one grant, one completion receipt, original and two variants');
  assert.equal(reads.filter(key => key === entry.source_key).length, 1);
  assert.equal(reads.some(key => key.includes('/prepared/') || key.startsWith(entry.aliases[0].key) || key.endsWith('.receipt.json')), false);
  reads.length = 0;
  await prepareMediaBatch(publication, root, 0, { materialize: true });
  assert.equal(reads.length, 2, 'overlapping retained manifests reuse local verified files');
}, 1, true));

test('completion receipts bind source, storage and destinations but ignore editorial changes', async () => withMediaFixture(async ({ publication, entries: [entry] }) => {
  const manifest = publication.media_manifest, key = mediaReceiptKey(manifest, entry);
  assert.equal(mediaReceiptKey(manifest, { ...entry, title: 'A new title', alt: 'New alt text' }), key);
  for (const changed of [{ ...entry, sha256: 'f'.repeat(64) }, { ...entry, public_path: '/new.png' }, { ...entry, aliases: [] }]) assert.notEqual(mediaReceiptKey(manifest, changed), key);
  assert.notEqual(mediaReceiptKey({ ...manifest, public_bucket: 'other' }, entry), key);
}));

test('interrupted preparation never publishes a completion receipt; cached artifacts still verify on use', async () => withMediaFixture(async ({ publication, root, stored, entries: [entry] }) => {
  const fetchBefore = globalThis.fetch, key = mediaReceiptKey(publication.media_manifest, entry);
  globalThis.fetch = (url, options) => String(url).endsWith('.avif') && options?.method === 'PUT' ? Promise.reject(Error('interrupted')) : fetchBefore(url, options);
  await assert.rejects(() => prepareMediaBatch(publication, root), /media_transfer_interrupted/);
  assert.equal(stored.has(key), false);
  globalThis.fetch = fetchBefore;
  await prepareMediaBatch(publication, root);
  assert.ok(stored.has(key));
  const variant = entry.public_key + `.v1.w320.${entry.sha256.slice(0, 16)}.webp`;
  stored.set(variant, Buffer.from('corrupt'));
  await assert.rejects(() => prepareMediaBatch(publication, root, 0, { materialize: true }), /byte verification/);
  stored.delete(variant);
  await assert.rejects(() => prepareMediaBatch(publication, root, 0, { materialize: true }), /byte verification/);
}, 1, true));

test('completion receipts cannot change artifact scope or silently omit variants', async () => withMediaFixture(async ({ publication, root, stored, entries: [entry] }) => {
  await prepareMediaBatch(publication, root);
  const key = mediaReceiptKey(publication.media_manifest, entry), receipt = JSON.parse(stored.get(key));
  for (const invalid of [{ ...receipt, key: 'other' }, { ...receipt, recipe_sha256: 'other' }, { ...receipt, variants: [] }, { ...receipt, variants: [{ ...receipt.variants[0], format: '../escape' }, receipt.variants[1]] }]) {
    stored.set(key, Buffer.from(JSON.stringify(invalid)));
    await assert.rejects(() => prepareMediaBatch(publication, root), /completion receipt/);
  }
}, 1, true));

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

test('overlaps preparation and cached materialization with at most sixteen small files and one grant download', async () => withMediaFixture(async ({ publication, root }) => {
  const originalFetch = globalThis.fetch; let active = 0, peak = 0, grants = 0;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname === '/grant') grants++;
    if (new URL(url).pathname.startsWith('/private/')) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
    }
    return originalFetch(url, options);
  };
  await prepareMediaBatch(publication, root);
  assert.ok(peak > 8 && peak <= 16);
  assert.equal(grants, 1);
  peak = 0;
  assert.equal((await prepareMedia(publication, root)).length, 32);
  assert.ok(peak > 8 && peak <= 16);
  assert.equal(active, 0);
}, 32));

test('drains an interrupted parallel group and safely reuses its completed copies on retry', async () => withMediaFixture(async ({ publication, root, entries, stored, writes }) => {
  const originalFetch = globalThis.fetch; let active = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith(entries[2].source_key)) return new Response(null, { status: 403 });
    if (new URL(url).pathname.startsWith('/private/')) {
      active++;
      await new Promise(resolve => setTimeout(resolve, 20));
      active--;
    }
    return originalFetch(url, options);
  };
  await assert.rejects(() => prepareMediaBatch(publication, root), /publication access/);
  assert.equal(active, 0, 'a failed batch must not leave sibling transfers running');
  assert.ok(stored.has(entries[4].aliases[0].key), 'the rest of the admitted group finished and verified its copies');
  assert.equal(stored.has(entries[17].public_key), false, 'a failure must not admit another group');
  globalThis.fetch = originalFetch;
  assert.deepEqual(await prepareMediaBatch(publication, root), { cursor: 24, total: 24 });
  assert.ok([...writes.values()].every(count => count === 1), 'a fresh process reuses verified partial work');
}, 24));

test('releases missing and denied response bodies instead of exhausting storage connections', async () => withMediaFixture(async ({ publication, root, entries }) => {
  const originalFetch = globalThis.fetch; let open = 0, closed = 0;
  const errorResponse = status => {
    open++;
    return new Response(new ReadableStream({ cancel() { open--; closed++; } }), { status });
  };
  globalThis.fetch = async (url, options) => {
    if (open >= 5) throw Error('simulated exhausted storage connection pool');
    const response = await originalFetch(url, options);
    return response.status === 404 ? errorResponse(404) : response;
  };
  await prepareMediaBatch(publication, root);
  assert.equal(open, 0);
  assert.equal(closed, 16);
  globalThis.fetch = async (url, options) => String(url).endsWith(entries[0].source_key) ? errorResponse(403) : originalFetch(url, options);
  await assert.rejects(() => prepareMediaBatch(publication, root), /publication access/);
  assert.equal(open, 0);
  assert.equal(closed, 17);
}, 8));

test('background preparation writes only private variants and a later publication reuses them', async () => withMediaFixture(async ({ publication, root, stored, writes, entries: [entry] }) => {
  const progress = await prepareMediaBatch(publication, root, 0, { cacheOnly: true });
  assert.equal(progress.cursor, 1);
  assert.equal(stored.has(entry.public_key), false);
  assert.equal(stored.has(entry.aliases[0].key), false);
  assert.equal([...writes.keys()].every(key => key.startsWith('private/')), true);
  const privateWrites = [...writes.entries()];
  await prepareMedia(publication, root);
  assert.equal(publication.media[0].variants.length, 2);
  for (const [key, count] of privateWrites) assert.equal(writes.get(key), count);
  assert.equal(stored.has(entry.public_key), true);
}));

test('warm publication makes no write attempts and backfills a missing private cache only once', async t => withMediaFixture(async ({ publication, root, stored }) => {
  await prepareMediaBatch(publication, root, 0, { cacheOnly: true });
  await prepareMedia(publication, root);
  const originalFetch = globalThis.fetch; const puts = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'PUT') puts.push(new URL(url).pathname);
    return originalFetch(url, options);
  };
  const toBuffer = sharp.prototype.toBuffer; let encodings = 0;
  t.mock.method(sharp.prototype, 'toBuffer', function (...args) { encodings++; return toBuffer.apply(this, args); });
  await prepareMediaBatch(publication, root);
  assert.equal((await prepareMediaBatch(publication, root, 0, { materialize: true })).files.length, 3);
  assert.deepEqual(puts, [], 'verified private and public variants need no conditional write attempts');
  assert.equal(encodings, 0);

  for (const key of stored.keys()) if (key.includes('/prepared/')) stored.delete(key);
  await prepareMedia(publication, root);
  assert.equal(puts.length, 4, 'backfill the two variants and receipts from verified public bytes');
  assert.ok(puts.every(key => key.startsWith('/private/')));
  assert.equal(encodings, 0);
  puts.length = 0;
  await prepareMedia(publication, root);
  assert.deepEqual(puts, [], 'the next publication reuses the backfilled cache');
}));

test('materializes bounded slices without losing current or retained media metadata', async () => withMediaFixture(async ({ publication, root }) => {
  await prepareMediaBatch(publication, root);
  publication.retained_media_manifests = [structuredClone(publication.media_manifest)];
  const first = await prepareMediaBatch(publication, root, 0, { maxEntries: 1, materialize: true });
  assert.equal(first.cursor, 1); assert.equal(first.total, 2); assert.equal(first.files.length, 3); assert.equal(first.media.length, 0);
  const second = await prepareMediaBatch(publication, root, 1, { maxEntries: 1, materialize: true });
  assert.equal(second.cursor, 2); assert.equal(second.files.length, 3); assert.equal(second.media.length, 1); assert.equal(second.media[0].variants.length, 2);
}));

test('final materialization reads only source originals and verified public variants', async t => withMediaFixture(async ({ publication, root, entries: [entry] }) => {
  await prepareMediaBatch(publication, root);
  const originalFetch = globalThis.fetch; const reads = [];
  globalThis.fetch = async (url, options) => {
    const key = new URL(url).pathname.slice(1);
    assert.notEqual(options?.method, 'PUT', 'materialization must not write to storage');
    assert.equal(key.includes('/prepared/') || key.startsWith(entry.aliases[0].key) || key === entry.public_key, false, 'do not repeat private-cache or alias preparation');
    reads.push(key); return originalFetch(url, options);
  };
  t.mock.method(sharp.prototype, 'toBuffer', () => { throw Error('materialization must not encode'); });
  const result = await prepareMediaBatch(publication, root, 0, { materialize: true });
  assert.equal(result.files.length, 3); assert.equal(result.media[0].variants.length, 2);
  assert.equal(reads.length, 6, 'one grant, one original, two receipts and two variants');
  for (const file of result.files) assert.ok((await fs.stat(file.source)).size > 0);
}));

test('final materialization rejects a missing or corrupt prepared variant without repairing storage', async () => withMediaFixture(async ({ publication, root, stored, entries: [entry] }) => {
  await prepareMediaBatch(publication, root);
  const key = entry.public_key + `.v1.w320.${entry.sha256.slice(0, 16)}.webp`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { assert.notEqual(options?.method, 'PUT'); return originalFetch(url, options); };
  stored.set(key, Buffer.from('corrupt variant'));
  await assert.rejects(() => prepareMediaBatch(publication, root, 0, { materialize: true }), /byte verification/);
  stored.delete(key);
  await assert.rejects(() => prepareMediaBatch(publication, root, 0, { materialize: true }), /Prepared media is unavailable/);
}));


test('storage groups overlap small files and reserve bounded memory for large or unknown files', () => {
  const small = Array.from({ length: 1000 }, () => ({ size_bytes: 150000 }));
  assert.equal(mediaTransferGroupSize(small, 0, 8), 8);
  assert.equal(mediaTransferGroupSize(small, 998, 8), 2);
  assert.equal(mediaTransferGroupSize(Array.from({ length: 8 }, () => ({ size_bytes: 25 * 1024 * 1024 })), 0, 8), 2);
  assert.equal(mediaTransferGroupSize(Array.from({ length: 8 }, () => ({})), 0, 8), 2);
  assert.equal(mediaTransferGroupSize(small.map(entry => ({ entry })), 0, 3), 3);
});


test('storage throttling reduces subsequent groups and healthy transfers restore capacity', async () => {
  const adaptive = await import('./fixtures/static-publication/media.mjs?adaptive-test');
  await withMediaFixture(async ({ publication, root }) => {
    const fetchBefore = globalThis.fetch; let throttled = false, active = 0, peak = 0;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).pathname.startsWith('/private/')) {
        if (!throttled) { throttled = true; return new Response(null, { status: 429, headers: { 'Retry-After': '0' } }); }
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2)); active--;
      }
      return fetchBefore(url, options);
    };
    assert.deepEqual(await adaptive.prepareMediaBatch(publication, root), { cursor: 12, total: 12 });
    assert.equal(peak, 8);
    assert.equal(adaptive.mediaTransferGroupSize(publication.media_manifest.entries, 0), 8);
  }, 12);
  await withMediaFixture(async ({ publication, root }) => {
    const first = await adaptive.prepareMediaBatch(publication, root);
    await adaptive.prepareMediaBatch(publication, root, first.cursor);
    assert.equal(adaptive.mediaTransferGroupSize(publication.media_manifest.entries, 0), 16);
  }, 160);
});
