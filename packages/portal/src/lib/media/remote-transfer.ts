import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client, getSignedUrl } from '../net/s3';
import { ConnectionError } from '../publishing/connections';

export interface TransferReceipt { protocol: 1; id: string; sha256: string; size: number; etag: string }
import { customerTransferService } from './transfer-service';
import { withoutRedirects } from '../net/no-redirect.mjs';
import { organizationTransfers, remoteMediaTransfers } from './transfer';
export { remoteTransfersEnabled } from './transfer-service';
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
/** A receipt is small; an error body is read only this far (a Cloudflare error page is HTML of several KB). */
const BODY_LIMIT = 2048;
/** Worker error codes and what they mean. Each keeps its own code, so a caller can tell a busy source from a refused one. */
const TRANSFER_ERRORS: Record<string, string> = {
  media_source_unavailable: 'The original file could not be downloaded. Check that it is still accessible on the source site.',
  media_source_temporarily_unavailable: 'The source site did not deliver the file just now (a server error or rate limit). The file was not copied.',
  media_transfer_interrupted: 'The media transfer was interrupted before the file was stored.',
  media_transfer_timeout: 'The media transfer timed out before the file was stored.',
  media_transfer_busy: 'The media transfer service is busy with another large file.',
  media_integrity_failed: 'The copied file does not match the original. Its references have not been changed.',
  media_file_too_large: 'The original file exceeds the 25 MB upload limit.',
  media_source_invalid: 'The source must be a publicly accessible website URL.',
  media_destination_unavailable: 'The destination storage rejected the file. Check Media storage in Publishing.',
  media_transfer_resources_exceeded: 'The Cloudflare account’s Workers plan stopped the copy (CPU limit, error 1102). Workers Paid raises the limit. The file was not copied and is retried later.',
};
/** Reads at most `limit` bytes; `overflow` says whether the body was longer. */
async function readLimited(response: Response, limit: number): Promise<{ text: string; overflow: boolean }> {
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0, overflow = false;
  if (!reader) return { text: '', overflow };
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (size + chunk.value.length > limit) { chunks.push(chunk.value.subarray(0, limit - size)); size = limit; overflow = true; break; }
      size += chunk.value.length; chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { text: Buffer.concat(chunks).toString('utf8'), overflow };
}
const workerCode = (text: string): string | null => {
  try { const code = (JSON.parse(text) as { error?: unknown }).error; return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null; } catch { return null; }
};
const retryable = (status: number) => status === 429 || status >= 500;
/** A receipt is accepted only from the authenticated service and for this exact, fresh request. */
async function requestTransfer(orgId: string, input: Record<string, unknown>, fetchImpl = fetch): Promise<TransferReceipt> {
  const service = await customerTransferService(orgId);
  const started = Date.now();
  // Host only: enough to compare sources without logging file names or signed URLs.
  let sourceHost: string | undefined;
  try { sourceHost = new URL(String(input.source_url)).host; } catch { /* no source */ }
  const log = (event: string, fields: Record<string, unknown>) =>
    console.info(JSON.stringify({ event, operation: input.operation, source_host: sourceHost, ...fields, elapsed_ms: Date.now() - started }));
  const slots = organizationTransfers(orgId);
  for (let attempt = 0; ; attempt++) {
    const job = { ...input, protocol: 1, id: randomUUID(), expires_at: Date.now() + 90000 }, body = JSON.stringify(job);
    let exchange: { response: Response; text: string; overflow: boolean };
    try {
      exchange = await slots.run('worker', 1, async () => {
        const response = await withoutRedirects(fetchImpl)(service.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(90000),
          headers: { 'Content-Type': 'application/json', 'x-typeroll-signature': sign(service.secret, body) }, body });
        return { response, ...await readLimited(response, BODY_LIMIT) };
      });
    } catch {
      if (attempt < 2) { log('media_transfer_retry', { attempt: attempt + 1, reason: 'network' }); await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); continue; }
      log('media_transfer_failed', { attempts: attempt + 1, reason: 'network', code: 'media_transfer_interrupted' });
      throw new ConnectionError('The connection to the media transfer service was interrupted.', 503, 'media_transfer_interrupted', { upstream_status: null, worker_code: null });
    }
    const { response, text } = exchange;
    // Errors first: a 5xx error page from Cloudflare (1101, 1102, 1015) is HTML
    // larger than a receipt and must be retried like any other 5xx.
    if (!response.ok) {
      const status = response.status, code = workerCode(text);
      // The Worker answers every error with its own JSON code. A 503 without one is Cloudflare
      // stopping the Worker, in practice its plan's CPU limit (error 1102 on Workers Free).
      const resourcesExceeded = status === 503 && !code;
      const reason = resourcesExceeded ? 'http_503:resources_exceeded' : `http_${status}${code ? `:${code}` : ''}`;
      if (resourcesExceeded) {
        // Repeating the copy at once at the same concurrency would only be stopped again:
        // run this organization's copies one at a time and try once more after a pause.
        slots.throttle();
        if (attempt < 1) { log('media_transfer_retry', { attempt: attempt + 1, reason, upstream_status: status, worker_code: null, concurrency: slots.limit }); await new Promise(resolve => setTimeout(resolve, 5000)); continue; }
      } else if (retryable(status)) {
        // The customer's Worker or its source is overloaded: run fewer copies at once for a while.
        remoteMediaTransfers.congested();
        if (attempt < 2) { log('media_transfer_retry', { attempt: attempt + 1, reason, upstream_status: status, worker_code: code }); await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); continue; }
      }
      const known = resourcesExceeded ? 'media_transfer_resources_exceeded' : code && TRANSFER_ERRORS[code] ? code : null;
      const failureCode = known ?? 'media_transfer_unavailable';
      log('media_transfer_failed', { attempts: attempt + 1, reason, upstream_status: status, worker_code: code, code: failureCode });
      throw new ConnectionError(known ? TRANSFER_ERRORS[known] : `The media transfer service answered HTTP ${status}. The file was not copied.`,
        retryable(status) ? 503 : 422, failureCode, { upstream_status: status, worker_code: code });
    }
    const { overflow } = exchange;
    if (overflow || !text) throw new ConnectionError('Media transfer returned an invalid receipt.', 503, 'media_transfer_unavailable', { upstream_status: response.status, worker_code: null });
    const supplied = response.headers.get('x-typeroll-signature');
    if (!supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(sign(service.secret, text), 'hex'))) throw new ConnectionError('Media transfer receipt could not be authenticated.', 503, 'media_transfer_unavailable');
    const receipt = JSON.parse(text) as TransferReceipt;
    if (receipt.protocol !== 1 || receipt.id !== job.id || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.size) || receipt.size < 1 || receipt.size > 25 * 1024 * 1024 ||
        !/^"[^"\r\n]{1,200}"$/.test(receipt.etag) || (input.expected_sha256 && input.expected_sha256 !== receipt.sha256) || (input.expected_size !== undefined && input.expected_size !== receipt.size)) throw new ConnectionError('The copied file does not match its transfer request.', 422, 'media_integrity_failed');
    log('media_transfer_receipt', { transferred_bytes: receipt.size, portal_file_bytes: 0, attempts: attempt + 1, duration_ms: Date.now() - started });
    return receipt;
  }
}
// Unreserved and sub-delimiter ASCII stays as written; everything else is percent-encoded as UTF-8.
const encodeSegment = (segment: string) => Array.from(segment, char => /[A-Za-z0-9\-._~!$&'()*+,;=:@]/.test(char) ? char : encodeURIComponent(char)).join('');
/**
 * The source URL as given, then its path in NFC and in NFD. A file named
 * `käyttö.jpg` can be stored on the source server in either Unicode form, and
 * the URL only finds it in the matching one. Paths without non-ASCII characters
 * have one candidate.
 */
export function sourceUrlCandidates(sourceUrl: string): string[] {
  const url = new URL(sourceUrl);
  let segments: string[];
  try { segments = url.pathname.split('/').map(segment => decodeURIComponent(segment)); } catch { return [sourceUrl]; }
  if (!segments.some(segment => /[^\x00-\x7f]/.test(segment))) return [sourceUrl];
  const candidates = [sourceUrl];
  for (const form of ['NFC', 'NFD'] as const) {
    const variant = new URL(url.href);
    variant.pathname = segments.map(segment => encodeSegment(segment.normalize(form))).join('/');
    if (!candidates.some(candidate => new URL(candidate).href === variant.href)) candidates.push(variant.href);
  }
  return candidates;
}
export async function copyWithTransferService(input: { orgId: string; sourceUrl: string; client: S3Client; bucket: string; key: string; contentType: string; expectedSha256?: string; expectedSize?: number }) {
  // Current transfer Workers hash the copy once and never read it back. `verify_url` is
  // still sent because a Worker deployed by an older Typeroll requires it until its next use upgrades it.
  const [upload_url, verify_url] = await Promise.all([
    getSignedUrl(input.client, new PutObjectCommand({ Bucket: input.bucket, Key: input.key, ContentType: input.contentType, CacheControl: 'private, no-store' }), { expiresIn: 600 }),
    getSignedUrl(input.client, new GetObjectCommand({ Bucket: input.bucket, Key: input.key }), { expiresIn: 600 }),
  ]);
  const candidates = sourceUrlCandidates(input.sourceUrl);
  for (const [index, source_url] of candidates.entries()) {
    try {
      return await requestTransfer(input.orgId, { operation: 'copy', source_url, upload_url, verify_url, content_type: input.contentType,
        expected_sha256: input.expectedSha256, expected_size: input.expectedSize });
    } catch (error) {
      if (index === candidates.length - 1 || !(error instanceof ConnectionError) || error.code !== 'media_source_unavailable') throw error;
    }
  }
  throw new ConnectionError('The original file could not be downloaded.', 422, 'media_source_unavailable');
}
export async function verifyWithTransferService(orgId: string, client: S3Client, bucket: string, key: string, expectedSha256?: string, expectedSize?: number) {
  const source_url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 600 });
  return requestTransfer(orgId, { operation: 'verify', source_url, expected_sha256: expectedSha256, expected_size: expectedSize });
}
