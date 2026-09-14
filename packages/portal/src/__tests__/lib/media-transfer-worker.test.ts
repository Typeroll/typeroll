import { afterEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import worker, { signature, transferFile, validateJob } from '../../lib/media/transfer-worker.mjs';
class Digest extends WritableStream {
  digest: Promise<ArrayBuffer>;
  constructor() {
    const hash = createHash('sha256'); let resolve: (value: ArrayBuffer) => void, reject: (error: unknown) => void;
    const digest = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; });
    super({ write(chunk) { hash.update(chunk); }, close() { const value = hash.digest(); resolve(value.buffer.slice(value.byteOffset, value.byteOffset + value.length)); }, abort(error) { reject(error); } });
    this.digest = digest;
  }
}
class Fixed extends TransformStream {
  constructor(length: number) { let size = 0; super({ transform(chunk, controller) { size += chunk.length; if (size > length) throw Error('length overflow'); controller.enqueue(chunk); }, flush() { if (size !== length) throw Error('length mismatch'); } }); }
}
const storage = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/bucket/incoming?X-Amz-Signature=synthetic`;
const job = () => ({ protocol: 1, operation: 'copy', id: '00000000-0000-0000-0000-000000000000', expires_at: Date.now() + 90000,
  source_url: 'https://wordpress.example.com/uploads/photo.png', upload_url: storage, verify_url: storage, content_type: 'image/png' });
afterEach(() => vi.unstubAllGlobals());
it('streams an 18 MiB original and verifies the stored copy without buffering the source', async () => {
  let generated = 0, uploaded = 0; const count = 288, chunk = new Uint8Array(65536).fill(17);
  const expected = createHash('sha256'); for (let i = 0; i < count; i++) expected.update(chunk);
  const source = () => new ReadableStream({ pull(controller) { generated++; if (generated > count) controller.close(); else controller.enqueue(chunk); } });
  const fetcher = vi.fn(async (url, options) => {
    if (String(url).includes('wordpress')) return new Response(source(), { headers: { 'content-length': String(count * chunk.length) } });
    if (options?.method === 'PUT') {
      const reader = options.body.getReader();
      for (;;) { const { value, done } = await reader.read(); if (done) break; uploaded += value.length; expect(generated * chunk.length - uploaded).toBeLessThan(1024 * 1024); }
      return new Response(null, { headers: { etag: '"stored"' } });
    }
    let n = 0; return new Response(new ReadableStream({ pull(controller) { if (n++ === count) controller.close(); else controller.enqueue(chunk); } }), { headers: { etag: '"stored"' } });
  });
  expect(await transferFile(job(), { fetchImpl: fetcher, Digest, Fixed })).toEqual({ sha256: expected.digest('hex'), size: count * chunk.length, etag: '"stored"' });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('rejects corruption, unexpected source hashes and changed destination identities', async () => {
  for (const kind of ['corrupt', 'etag', 'expected']) {
    const fetcher = vi.fn(async (url, options) => String(url).includes('wordpress') ? new Response('abc') : options?.method === 'PUT' ? new Response(null, { headers: { etag: '"original"' } }) : new Response(kind === 'corrupt' ? 'abd' : 'abc', { headers: { etag: kind === 'etag' ? '"changed"' : '"original"' } }));
    await expect(transferFile({ ...job(), ...(kind === 'expected' ? { expected_sha256: '0'.repeat(64) } : {}) }, { fetchImpl: fetcher, Digest, Fixed })).rejects.toThrow(/media_integrity_failed|media_copy_changed/);
  }
});
it('rejects expired, oversized and redirected grants before copying bytes', async () => {
  expect(() => validateJob({ ...job(), expires_at: 1 })).toThrow();
  expect(() => validateJob({ ...job(), verify_url: storage.replace('/incoming?', '/other?') })).toThrow();
  expect(() => validateJob({ ...job(), source_url: 'http://169.254.169.254/latest/meta-data' })).toThrow();
  const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
  await expect(transferFile(job(), { fetchImpl: redirect, Digest, Fixed })).rejects.toThrow('media_source_invalid');
  expect(redirect).toHaveBeenCalledTimes(1);
  const large = vi.fn(async () => new Response('a', { headers: { 'content-length': String(26 * 1024 * 1024) } }));
  await expect(transferFile(job(), { fetchImpl: large, Digest, Fixed })).rejects.toThrow('media_file_too_large');
  expect(large).toHaveBeenCalledTimes(1);
});
it('rejects unauthorized requests and binds signed health receipts to this worker and request', async () => {
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, DigestStream: Digest });
  const secret = 'synthetic-worker-secret-for-tests-only';
  const body = JSON.stringify(job());
  expect((await worker.fetch(new Request('https://worker.example.com/transfer', { method: 'POST', body }), { TRANSFER_SECRET: secret })).status).toBe(403);
  const response = await worker.fetch(new Request('https://worker.example.com/health', { method: 'POST', body, headers: { 'x-typeroll-signature': await signature(secret, body) } }), { TRANSFER_SECRET: secret, WORKER_SHA: 'candidate' });
  const text = await response.text(); expect(JSON.parse(text)).toMatchObject({ id: job().id, worker_sha: 'candidate' });
  expect(response.headers.get('x-typeroll-signature')).toBe(await signature(secret, text));
});
it('stops a streaming source when the destination rejects before consuming the body', async () => {
  let canceled = false;
  const fetcher = vi.fn(async (_url, options) => options?.method === 'PUT' ? new Response(null, { status: 403 }) : new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { canceled = true; } }), { headers: { 'content-length': String(18 * 1024 * 1024) } }));
  await expect(transferFile(job(), { fetchImpl: fetcher, Digest, Fixed })).rejects.toThrow('media_destination_unavailable');
  expect(canceled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
