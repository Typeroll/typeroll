import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise the deployed module with native fetch, DigestStream and FixedLengthStream.
// The pinned local workerd supports this date; staging also checks the deployed date.
const compatibilityDate = '2026-09-04';
const secret = 'synthetic-media-transfer-runtime-test';
const fixture = `
let stored;
export default { async fetch(request) {
  const url = new URL(request.url), mode = url.searchParams.get('case');
  if (url.hostname === 'source.example.com') {
    let remaining = 288;
    return new Response(new ReadableStream({ pull(controller) {
      if (!remaining--) controller.close(); else controller.enqueue(new Uint8Array(65536).fill(17));
    } }), { headers: mode === 'buffered' ? {} : {'Content-Length': String(288 * 65536)} });
  }
  if (request.method === 'PUT') {
    if (mode === 'redirect-put') return new Response(null, {status: 307, headers: {Location: 'https://unexpected.example.com/secret'}});
    stored = await request.arrayBuffer();
    return new Response(null, {headers: {ETag: '"stored"'}});
  }
  if (mode === 'redirect-get') return new Response(null, {status: 302, headers: {Location: 'https://unexpected.example.com/secret'}});
  if (url.hostname === 'unexpected.example.com') throw Error('A signed storage redirect must never be followed');
  return new Response(stored, {headers: {ETag: '"stored"'}});
} };`;

test('customer media transfers run in workerd and never follow signed storage redirects', { timeout: 60000 }, async () => {
  const source = await readFile(new URL('../packages/portal/src/lib/media/transfer-worker.mjs', import.meta.url), 'utf8');
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    {name: 'transfer', modules: [{type: 'ESModule', path: 'entry.mjs', contents: "export {default} from './transfer.mjs';"}, {type: 'ESModule', path: 'transfer.mjs', contents: source}], compatibilityDate, bindings: {TRANSFER_SECRET: secret}, outboundService: 'storage-fixture'},
    {name: 'storage-fixture', modules: true, compatibilityDate, script: fixture},
  ] }));
  const bytes = 288 * 65536;
  const expected = createHash('sha256').update(Buffer.alloc(bytes, 17)).digest('hex');
  try {
    for (const mode of ['streaming', 'buffered', 'redirect-put', 'redirect-get', 'verify']) {
      const storage = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/bucket/incoming?X-Amz-Signature=synthetic&case=${mode}`;
      const job = { protocol: 1, operation: mode === 'verify' ? 'verify' : 'copy', id: randomUUID(), expires_at: Date.now() + 90000,
        source_url: mode === 'verify' ? storage : `https://source.example.com/photo.png?case=${mode}`,
        upload_url: storage, verify_url: storage, content_type: 'image/png', expected_size: bytes, expected_sha256: expected };
      const body = JSON.stringify(job);
      const response = await mf.dispatchFetch('https://transfer.example.com/transfer', { method: 'POST', body,
        headers: {'x-typeroll-signature': createHmac('sha256', secret).update(body).digest('hex')} });
      const text = await response.text();
      if (mode.startsWith('redirect-')) {
        assert.equal(response.status, 422, text);
        assert.equal(JSON.parse(text).error, mode === 'redirect-put' ? 'media_destination_unavailable' : 'media_copy_changed');
      } else {
        assert.equal(response.status, 200, `${mode}: ${text}`);
        assert.deepEqual(JSON.parse(text), {protocol: 1, id: job.id, sha256: expected, size: bytes, etag: '"stored"'});
        assert.equal(response.headers.get('x-typeroll-signature'), createHmac('sha256', secret).update(text).digest('hex'));
      }
    }
  } finally { await mf.dispose(); }
});
