// Standalone Cloudflare module. It receives short-lived object grants, never bucket credentials.
export const TRANSFER_PROTOCOL = 1;
export const MAX_TRANSFER_BYTES = 25 * 1024 * 1024;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const failure = (code, status = 422) => Object.assign(new Error(code), { code, status });
const ownFailure = error => typeof error?.code === 'string' && error.code.startsWith('media_');
export async function signature(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}
async function authenticated(secret, text, supplied) {
  if (!/^[a-f0-9]{64}$/.test(supplied ?? '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(supplied.match(/../g), value => parseInt(value, 16)), encoder.encode(text));
}
export function publicSource(value) {
  const url = new URL(value);
  // The service has no private bindings or account credentials. Reject literal/internal destinations too.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) throw failure('media_source_invalid');
  return url;
}
function storageGrant(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) || url.username || url.password || url.port ||
      !url.searchParams.has('X-Amz-Signature')) throw failure('media_grant_invalid');
  return url;
}
export function validateJob(job, now = Date.now()) {
  if (job.protocol !== TRANSFER_PROTOCOL || !['copy', 'verify'].includes(job.operation) || !/^[a-f0-9-]{36}$/.test(job.id ?? '') ||
      !Number.isSafeInteger(job.expires_at) || job.expires_at < now || job.expires_at > now + 120000 ||
      (job.expected_sha256 && !/^[a-f0-9]{64}$/.test(job.expected_sha256)) ||
      (job.expected_size !== undefined && (!Number.isSafeInteger(job.expected_size) || job.expected_size < 1 || job.expected_size > MAX_TRANSFER_BYTES))) throw failure('media_transfer_invalid');
  publicSource(job.source_url);
  if (job.operation === 'verify') storageGrant(job.source_url);
  else {
    const put = storageGrant(job.upload_url), get = job.verify_url === undefined ? put : storageGrant(job.verify_url);
    if (put.origin + put.pathname !== get.origin + get.pathname || !/^(image\/[a-zA-Z0-9.+-]+|application\/pdf)$/.test(job.content_type ?? '')) throw failure('media_grant_invalid');
  }
  return job;
}
async function sourceResponse(url, fetchImpl, signal) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(publicSource(url), { redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || redirects === 3 || new URL(url).hostname.endsWith('.r2.cloudflarestorage.com')) throw failure('media_source_redirect');
      url = new URL(location, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw failure(response.status === 429 || response.status >= 500 ? 'media_source_temporarily_unavailable' : 'media_source_unavailable', response.status === 429 || response.status >= 500 ? 503 : 422); }
    return response;
  }
}
/** Bytes per native read. Fetch bodies arrive in 4 KiB pieces; reading 256 KiB at once makes a 4 MB file 16 JavaScript steps instead of about a thousand. */
const READ_BYTES = 256 * 1024;
/**
 * Reads the body once and hands every piece to each sink in turn; returns the size. Each write is awaited,
 * so a slow destination holds the source back and at most one piece per transfer is in memory.
 * (`tee()` would avoid the loop, but workerd buffers the slower branch without limit.)
 */
async function pump(body, sinks, signal) {
  if (!body) throw failure('media_source_empty');
  let reader, byob = true;
  try { reader = body.getReader({ mode: 'byob' }); } catch { reader = body.getReader(); byob = false; }
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw failure('media_transfer_timeout', 503);
      const { value, done } = byob ? await reader.read(new Uint8Array(READ_BYTES), { min: READ_BYTES }) : await reader.read();
      if (value?.byteLength) {
        size += value.byteLength;
        if (size > MAX_TRANSFER_BYTES) throw failure('media_file_too_large');
        for (const sink of sinks) await sink.write(value);
      }
      if (done) break;
    }
    if (!size) throw failure('media_source_empty');
    return size;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** One SHA-256 over the body, computed natively by DigestStream. */
async function digestBody(body, Digest, signal) {
  const digest = new Digest('SHA-256'), writer = digest.getWriter();
  // Attach a rejection handler before a stream abort can reject the digest promise.
  const value = Promise.resolve(digest.digest); value.catch(() => {});
  try {
    const size = await pump(body, [writer], signal);
    await writer.close();
    return { sha256: hex(await value), size };
  } catch (error) { await writer.abort(error).catch(() => {}); throw error; }
  finally { writer.releaseLock(); }
}
const destinationFailure = response => failure('media_destination_unavailable', response.status >= 500 || response.status === 429 ? 503 : 422);
let bufferedTransferActive = false;
/**
 * Copies a source into a storage grant, hashing every byte exactly once on the way.
 *
 * Integrity: the same pieces, in the same order, go to the SHA-256 and to the upload (`pump`). With a known
 * length the upload is a FixedLengthStream, so the PUT carries exactly that Content-Length and fails if the
 * source delivers more or fewer bytes. A successful PUT stores the request body atomically under the ETag it
 * returns, and TLS protects the bytes on the way. The stored object therefore is the hashed bytes, and the
 * digest and size are checked against the expected values before a receipt is issued. Reading the object back
 * to hash it again would only re-check R2 itself. The portal pins every later step to the returned ETag
 * (CopySourceIfMatch), so a concurrent overwrite cannot slip in, and nothing references the object until then:
 * a mismatch leaves it at a key that is deleted or expires (`transfer-staging/`).
 * `verify_url` is still accepted for portals that send it, but no longer read.
 */
export async function transferFile(job, { fetchImpl = fetch, Digest = crypto.DigestStream, Fixed = globalThis.FixedLengthStream, signal = new AbortController().signal } = {}) {
  const source = await sourceResponse(job.source_url, fetchImpl, signal);
  const advertised = Number(source.headers.get('content-length'));
  if (advertised > MAX_TRANSFER_BYTES) { await source.body?.cancel(); throw failure('media_file_too_large'); }
  if (job.operation === 'verify') {
    const result = await digestBody(source.body, Digest, signal);
    if ((job.expected_sha256 && result.sha256 !== job.expected_sha256) || (job.expected_size !== undefined && result.size !== job.expected_size)) throw failure('media_integrity_failed');
    const etag = source.headers.get('etag'); if (!etag) throw failure('media_receipt_missing');
    return { ...result, etag };
  }
  const headers = { 'Content-Type': job.content_type, 'Cache-Control': 'private, no-store' };
  let result, uploaded;
  if (Number.isSafeInteger(advertised) && advertised > 0 && !source.headers.get('content-encoding')) {
    if (job.expected_size !== undefined && advertised !== job.expected_size) { await source.body?.cancel(); throw failure('media_integrity_failed'); }
    const digest = new Digest('SHA-256'), hashWriter = digest.getWriter(), fixed = new Fixed(advertised), uploadWriter = fixed.writable.getWriter();
    const digestValue = Promise.resolve(digest.digest); digestValue.catch(() => {});
    // Aborting the upload body rejects the next write, which stops reading the source, and fails the PUT.
    const halt = () => { void uploadWriter.abort().catch(() => {}); };
    // Fetch and the producer run together so backpressure never buffers a complete file.
    // Handle non-success responses below; Workers does not implement redirect: 'error'.
    const upload = fetchImpl(job.upload_url, { method: 'PUT', body: fixed.readable, duplex: 'half', redirect: 'manual', signal, headers })
      .then(response => { if (!response.ok) halt(); return response; }, error => { halt(); throw error; });
    const copy = pump(source.body, [hashWriter, uploadWriter], signal).then(async size => { await uploadWriter.close(); await hashWriter.close(); return size; });
    copy.catch(() => { halt(); void hashWriter.abort().catch(() => {}); });
    const [copied, sent] = await Promise.allSettled([copy, upload]);
    if (sent.status === 'fulfilled' && !sent.value.ok) { await sent.value.body?.cancel(); throw destinationFailure(sent.value); }
    if (copied.status === 'rejected' && ownFailure(copied.reason)) throw copied.reason;
    if (copied.status === 'rejected' || sent.status === 'rejected') throw failure('media_transfer_interrupted', 503);
    uploaded = sent.value;
    result = { sha256: hex(await digestValue), size: copied.value };
  } else {
    // Some WordPress origins omit Content-Length. Reserve one bounded buffer per isolate for those files.
    if (bufferedTransferActive) { await source.body?.cancel(); throw failure('media_transfer_busy', 503); }
    bufferedTransferActive = true;
    try {
      const chunks = [];
      const size = await pump(source.body, [{ write: chunk => { chunks.push(chunk); } }], signal);
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } chunks.length = 0;
      result = { sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), size };
      uploaded = await fetchImpl(job.upload_url, { method: 'PUT', body: bytes, redirect: 'manual', signal, headers });
    } finally { bufferedTransferActive = false; }
  }
  await uploaded.body?.cancel();
  if (!uploaded.ok) throw destinationFailure(uploaded);
  if ((job.expected_sha256 && result.sha256 !== job.expected_sha256) || (job.expected_size !== undefined && result.size !== job.expected_size)) throw failure('media_integrity_failed');
  const etag = uploaded.headers.get('etag'); if (!etag) throw failure('media_receipt_missing');
  return { ...result, etag };
}
export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || !['/transfer', '/health'].includes(new URL(request.url).pathname) || !env.TRANSFER_SECRET) return new Response(null, { status: 404 });
    let text;
    try { const reader = request.body.getReader(); const chunks = []; let size = 0; try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16384) throw failure('media_request_too_large', 413); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } text = new TextDecoder().decode(bytes); }
    catch { return new Response(null, { status: 413 }); }
    if (!await authenticated(env.TRANSFER_SECRET, text, request.headers.get('x-typeroll-signature'))) return new Response(null, { status: 403 });
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 80000);
    try {
      const input = JSON.parse(text);
      if (new URL(request.url).pathname === '/health') {
        if (input.protocol !== 1 || !/^[a-f0-9-]{36}$/.test(input.id ?? '') || !Number.isSafeInteger(input.expires_at) || input.expires_at < Date.now() || input.expires_at > Date.now() + 120000) throw failure('media_transfer_invalid');
        const receipt = JSON.stringify({ protocol: 1, id: input.id, worker_sha: env.WORKER_SHA });
        return new Response(receipt, { headers: { 'Cache-Control': 'no-store', 'x-typeroll-signature': await signature(env.TRANSFER_SECRET, receipt) } });
      }
      const job = validateJob(input);
      const receipt = JSON.stringify({ protocol: TRANSFER_PROTOCOL, id: job.id, ...await transferFile(job, { signal: abort.signal }) });
      return new Response(receipt, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-typeroll-signature': await signature(env.TRANSFER_SECRET, receipt) } });
    } catch (error) {
      return Response.json({ error: error.code ?? 'media_transfer_interrupted' }, { status: error.status ?? 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' } });
    } finally { clearTimeout(timer); }
  },
};
