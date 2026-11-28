import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { encodeRenderCache, inspectRenderCache, readRenderCache, MAX_RENDER_CACHE_BYTES, RENDER_CACHE_FORMAT } from '../packages/site-template/src/lib/publication-render-cache.mjs';
import { renderCacheReport } from '../packages/portal/src/lib/builds/render-cache-report.mjs';
import { renderReport } from '../packages/portal/src/lib/builds/contract.mjs';
const cache = routes => ({ format: RENDER_CACHE_FORMAT, routes });

test('compresses a raw cache beyond the old 32 MiB ceiling and restores every route', () => {
  const html = 'x'.repeat(180000);
  const value = cache(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`/article-${i}/`, { html }])));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > MAX_RENDER_CACHE_BYTES);
  const encoded = encodeRenderCache(value);
  assert.ok(encoded.bytes.length < 100000);
  assert.equal(encoded.retained_routes, 200);
  assert.deepEqual(readRenderCache(encoded.bytes), value);
});
test('reads existing JSON, rejects corruption and bounds gzip inflation', () => {
  const value = cache({ '/a/': { html: '<p>Safe</p>' } });
  assert.deepEqual(readRenderCache(Buffer.from(JSON.stringify(value))), value);
  assert.equal(inspectRenderCache(Buffer.from('{broken')).read, 'invalid');
  assert.equal(inspectRenderCache(Buffer.from(JSON.stringify({ ...value, format: -1 }))).read, 'format_mismatch');
  assert.equal(inspectRenderCache(gzipSync(Buffer.from('x'.repeat(10000))), { maxDecodedBytes: 1024 }).read, 'too_large');
});
test('keeps a bounded useful subset instead of discarding every route', () => {
  const value = cache(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/${i}/`, { html: 'x'.repeat(1000) }])));
  const encoded = encodeRenderCache(value, { maxDecodedBytes: 4096 });
  assert.ok(encoded.retained_routes > 0 && encoded.retained_routes < 20);
  assert.equal(encoded.retained_routes + encoded.omitted_routes, 20);
  assert.equal(Object.keys(readRenderCache(encoded.bytes).routes).length, encoded.retained_routes);
});
test('reports only bounded cache diagnostics and never provider URLs or content', () => {
  const diagnostic = renderCacheReport({ read: 'hit', save: 'partial', retained_routes: 200, omitted_routes: 3,
    invalidations: ['renderer_changed', 'https://private.invalid/t?secret'], error: 'private content', url: 'secret', stored_bytes: -1 });
  assert.deepEqual(diagnostic, { read: 'hit', save: 'partial', retained_routes: 200, omitted_routes: 3, invalidations: ['renderer_changed'] });
  assert.deepEqual(renderReport({ format: 1, mode: 'full', rendered: 1, reused: 0, total: 1, removed: 0, reason: 'no_valid_cache', cache: diagnostic }).cache, diagnostic);
});
