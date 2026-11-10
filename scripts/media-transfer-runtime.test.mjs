import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise the deployed module with native fetch, BYOB reads, DigestStream and FixedLengthStream.
// The pinned local workerd supports this date; staging also checks the deployed date.
const compatibilityDate = '2026-09-04';
const secret = 'synthetic-media-transfer-runtime-test';
// The storage fixture reads uploads slowly and records how far the source ran ahead of them,
// and how often the stored object was read back.
const fixture = `
let stored, generated = 0, maxAhead = 0, storageReads = 0;
export default { async fetch(request) {
  const url = new URL(request.url), mode = url.searchParams.get('case');
  if (url.pathname === '/stats') return Response.json({ maxAhead, storageReads, storedBytes: stored?.byteLength ?? 0 });
  if (url.hostname === 'source.example.com') {
    let remaining = 288; generated = 0; maxAhead = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (!remaining--) controller.close(); else { generated += 65536; controller.enqueue(new Uint8Array(65536).fill(17)); }
    } }), { headers: mode === 'buffered' ? {} : {'Content-Length': String(288 * 65536)} });
  }
  if (request.method === 'PUT') {
    if (mode === 'redirect-put') return new Response(null, {status: 307, headers: {Location: 'https://unexpected.example.com/secret'}});
    const reader = request.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      chunks.push(value); size += value.byteLength; maxAhead = Math.max(maxAhead, generated - size);
      if (chunks.length % 64 === 0) await scheduler.wait(1);
    }
    stored = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { stored.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(null, {headers: {ETag: '"stored"'}});
  }
  if (mode === 'redirect-verify') return new Response(null, {status: 302, headers: {Location: 'https://unexpected.example.com/secret'}});
  if (url.hostname === 'unexpected.example.com') throw Error('A signed storage redirect must never be followed');
  storageReads++;
  return new Response(stored, {headers: {ETag: '"stored"', 'Content-Length': String(stored.byteLength)}});
} };`;

test('customer media transfers run in workerd, hash once and never follow signed storage redirects', { timeout: 60000 }, async () => {
  const source = await readFile(new URL('../packages/portal/src/lib/media/transfer-worker.mjs', import.meta.url), 'utf8');
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    {name: 'transfer', modules: [{type: 'ESModule', path: 'entry.mjs', contents: "export {default} from './transfer.mjs';"}, {type: 'ESModule', path: 'transfer.mjs', contents: source}], compatibilityDate, bindings: {TRANSFER_SECRET: secret}, outboundService: 'storage-fixture'},
    {name: 'storage-fixture', modules: true, compatibilityDate, script: fixture},
  ] }));
  const bytes = 288 * 65536;
  const expected = createHash('sha256').update(Buffer.alloc(bytes, 17)).digest('hex');
  try {
    const storageFixture = await mf.getWorker('storage-fixture');
    const stats = async () => (await storageFixture.fetch('https://stats.example.com/stats')).json();
    for (const mode of ['streaming', 'buffered', 'mismatch', 'redirect-put', 'verify', 'redirect-verify']) {
      const storage = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/bucket/incoming?X-Amz-Signature=synthetic&case=${mode}`;
      const verify = mode.includes('verify');
      const job = { protocol: 1, operation: verify ? 'verify' : 'copy', id: randomUUID(), expires_at: Date.now() + 90000,
        source_url: verify ? storage : `https://source.example.com/photo.png?case=${mode}`,
        upload_url: storage, verify_url: storage, content_type: 'image/png', expected_size: bytes, expected_sha256: mode === 'mismatch' ? '0'.repeat(64) : expected };
      const before = await stats();
      const body = JSON.stringify(job);
      const response = await mf.dispatchFetch('https://transfer.example.com/transfer', { method: 'POST', body,
        headers: {'x-typeroll-signature': createHmac('sha256', secret).update(body).digest('hex')} });
      const text = await response.text();
      const after = await stats();
      if (mode.startsWith('redirect-') || mode === 'mismatch') {
        assert.equal(response.status, 422, `${mode}: ${text}`);
        assert.equal(JSON.parse(text).error, { 'redirect-put': 'media_destination_unavailable', 'redirect-verify': 'media_source_redirect', mismatch: 'media_integrity_failed' }[mode]);
      } else {
        assert.equal(response.status, 200, `${mode}: ${text}`);
        assert.deepEqual(JSON.parse(text), {protocol: 1, id: job.id, sha256: expected, size: bytes, etag: '"stored"'});
        assert.equal(response.headers.get('x-typeroll-signature'), createHmac('sha256', secret).update(text).digest('hex'));
      }
      if (!verify) {
        // A copy is hashed once on the way in; the stored object is never downloaded again.
        assert.equal(after.storageReads, before.storageReads, `${mode} read the stored copy back`);
      }
      if (mode === 'streaming') {
        assert.equal(after.storedBytes, bytes);
        // A slow destination holds the source back: far less than the file is ever held in memory.
        assert.ok(after.maxAhead < 2 * 1024 * 1024, `source ran ${after.maxAhead} bytes ahead of the upload`);
      }
    }
  } finally { await mf.dispose(); }
});
