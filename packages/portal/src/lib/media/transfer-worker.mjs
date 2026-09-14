// Standalone Cloudflare module. It receives short-lived object grants, never bucket credentials.
export const TRANSFER_PROTOCOL = 1;
export const MAX_TRANSFER_BYTES = 25 * 1024 * 1024;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const failure = (code, status = 422) => Object.assign(new Error(code), { code, status });
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
    const put = storageGrant(job.upload_url), get = storageGrant(job.verify_url);
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
async function digestBody(response, Digest, signal) {
  if (!response.body) throw failure('media_source_empty');
  const digest = new Digest('SHA-256'), writer = digest.getWriter(), reader = response.body.getReader();
  // Attach a rejection handler before a stream abort can reject the digest promise.
  const value = Promise.resolve(digest.digest); value.catch(() => {});
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw failure('media_transfer_timeout', 503);
      const { value: chunk, done } = await reader.read(); if (done) break;
      size += chunk.byteLength;
      if (size > MAX_TRANSFER_BYTES) throw failure('media_file_too_large');
      await writer.write(chunk);
    }
    if (!size) throw failure('media_source_empty');
    await writer.close();
    return { sha256: hex(await value), size };
  } catch (error) { await writer.abort(error).catch(() => {}); throw error; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); writer.releaseLock(); }
}
let bufferedTransferActive = false;
/** Streaming source and destination hashes are computed in Cloudflare, outside the portal. */
export async function transferFile(job, { fetchImpl = fetch, Digest = crypto.DigestStream, Fixed = globalThis.FixedLengthStream, signal = new AbortController().signal } = {}) {
  const source = await sourceResponse(job.source_url, fetchImpl, signal);
  const advertised = Number(source.headers.get('content-length'));
  if (advertised > MAX_TRANSFER_BYTES) { await source.body?.cancel(); throw failure('media_file_too_large'); }
  if (job.operation === 'verify') {
    const result = await digestBody(source, Digest, signal);
    if ((job.expected_sha256 && result.sha256 !== job.expected_sha256) || (job.expected_size !== undefined && result.size !== job.expected_size)) throw failure('media_integrity_failed');
    const etag = source.headers.get('etag'); if (!etag) throw failure('media_receipt_missing');
    return { ...result, etag };
  }
  let result, uploaded;
  if (Number.isSafeInteger(advertised) && advertised > 0 && !source.headers.get('content-encoding')) {
    const digest = new Digest('SHA-256'), writer = digest.getWriter(), fixed = new Fixed(advertised);
    const digestValue = Promise.resolve(digest.digest); digestValue.catch(() => {});
    let size = 0;
    const stop = new AbortController(), transferSignal = AbortSignal.any([signal, stop.signal]);
    const pipe = source.body.pipeThrough(new TransformStream({
      async transform(chunk, controller) { size += chunk.byteLength; if (size > MAX_TRANSFER_BYTES) throw failure('media_file_too_large'); await writer.write(chunk); controller.enqueue(chunk); },
      async flush() { await writer.close(); },
    })).pipeTo(fixed.writable, { signal: transferSignal });
    pipe.catch(() => { void writer.abort().catch(() => {}); });
    // Handle non-success responses below; Workers does not implement redirect: 'error'.
    // Fetch and the producer must run together so backpressure never buffers a complete file.
    const upload = fetchImpl(job.upload_url, { method: 'PUT', body: fixed.readable, duplex: 'half', redirect: 'manual', signal: transferSignal,
      headers: { 'Content-Type': job.content_type, 'Cache-Control': 'private, no-store' } }).then(response => {
        if (!response.ok) stop.abort();
        return response;
      }, error => { stop.abort(); throw error; });
    const writes = await Promise.allSettled([pipe, upload]);
    if (writes[1].status === 'fulfilled' && !writes[1].value.ok) {
      await writes[1].value.body?.cancel();
      throw failure('media_destination_unavailable', writes[1].value.status >= 500 || writes[1].value.status === 429 ? 503 : 422);
    }
    if (writes.some(value => value.status === 'rejected')) throw failure('media_transfer_interrupted', 503);
    uploaded = writes[1].value;
    result = { sha256: hex(await digestValue), size };
  } else {
    // Some WordPress origins omit Content-Length. Reserve one bounded buffer per isolate for those files.
    if (bufferedTransferActive) { await source.body?.cancel(); throw failure('media_transfer_busy', 503); }
    bufferedTransferActive = true;
    try {
      const chunks = []; let size = 0; const reader = source.body?.getReader();
      if (!reader) throw failure('media_source_empty');
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_TRANSFER_BYTES) throw failure('media_file_too_large'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } chunks.length = 0;
      result = { sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), size };
      uploaded = await fetchImpl(job.upload_url, { method: 'PUT', body: bytes, redirect: 'manual', signal, headers: { 'Content-Type': job.content_type, 'Cache-Control': 'private, no-store' } });
    } finally { bufferedTransferActive = false; }
  }
  await uploaded.body?.cancel();
  if (!uploaded.ok) throw failure('media_destination_unavailable', uploaded.status >= 500 || uploaded.status === 429 ? 503 : 422);
  if (!result.size || (job.expected_sha256 && result.sha256 !== job.expected_sha256) || (job.expected_size !== undefined && result.size !== job.expected_size)) throw failure('media_integrity_failed');
  const etag = uploaded.headers.get('etag'); if (!etag) throw failure('media_receipt_missing');
  const stored = await fetchImpl(job.verify_url, { redirect: 'manual', signal, headers: { 'If-Match': etag } });
  if (!stored.ok || stored.headers.get('etag') !== etag) { await stored.body?.cancel(); throw failure('media_copy_changed'); }
  const verified = await digestBody(stored, Digest, signal);
  if (result.sha256 !== verified.sha256 || result.size !== verified.size) throw failure('media_integrity_failed');
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
