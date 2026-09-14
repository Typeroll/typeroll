import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConnectionError } from '../publishing/connections';

export interface TransferReceipt { protocol: 1; id: string; sha256: string; size: number; etag: string }
import { customerTransferService } from './transfer-service';
export { remoteTransfersEnabled } from './transfer-service';
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
/** A receipt is accepted only from the authenticated service and for this exact, fresh request. */
async function requestTransfer(orgId: string, input: Record<string, unknown>, fetchImpl = fetch): Promise<TransferReceipt> {
  const service = await customerTransferService(orgId);
  for (let attempt = 0; ; attempt++) {
    const job = { ...input, protocol: 1, id: randomUUID(), expires_at: Date.now() + 90000 }, body = JSON.stringify(job);
    let response: Response;
    try {
      response = await fetchImpl(service.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', 'x-typeroll-signature': sign(service.secret, body) }, body });
    } catch {
      if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); continue; }
      throw new ConnectionError('The media transfer was interrupted. Retry the migration; completed files will be kept.', 503, 'media_transfer_interrupted');
    }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (!reader) throw new ConnectionError('Media transfer returned no receipt.', 503, 'media_transfer_unavailable');
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 2048) throw new ConnectionError('Media transfer returned an invalid receipt.', 503, 'media_transfer_unavailable'); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); continue; }
      let code: string; try { code = JSON.parse(text).error; } catch { code = 'media_transfer_unavailable'; }
      const descriptions: Record<string, string> = {
        media_source_unavailable: 'The original file could not be downloaded. Check that it is still accessible on the source site and retry.',
        media_integrity_failed: 'The copied file does not match the original. Its references have not been changed. Retry the migration.',
        media_file_too_large: 'The original file exceeds the 25 MB upload limit.',
        media_source_invalid: 'The source must be a publicly accessible website URL.',
        media_destination_unavailable: 'The destination rejected the file. Check Media storage in Publishing and retry.',
      };
      throw new ConnectionError(descriptions[code] ?? 'Media transfer could not finish. Retry the migration; completed files will be kept.', response.status >= 500 ? 503 : 422,
        descriptions[code] ? code : 'media_transfer_unavailable');
    }
    const supplied = response.headers.get('x-typeroll-signature');
    if (!supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(sign(service.secret, text), 'hex'))) throw new ConnectionError('Media transfer receipt could not be authenticated.', 503, 'media_transfer_unavailable');
    const receipt = JSON.parse(text) as TransferReceipt;
    if (receipt.protocol !== 1 || receipt.id !== job.id || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.size) || receipt.size < 1 || receipt.size > 25 * 1024 * 1024 ||
        !/^"[^"\r\n]{1,200}"$/.test(receipt.etag) || (input.expected_sha256 && input.expected_sha256 !== receipt.sha256) || (input.expected_size !== undefined && input.expected_size !== receipt.size)) throw new ConnectionError('The copied file does not match its transfer request.', 422, 'media_integrity_failed');
    console.info(JSON.stringify({ event: 'media_transfer_receipt', operation: input.operation, transferred_bytes: receipt.size, portal_file_bytes: 0 }));
    return receipt;
  }
}
export async function copyWithTransferService(input: { orgId: string; sourceUrl: string; client: S3Client; bucket: string; key: string; contentType: string; expectedSha256?: string; expectedSize?: number }) {
  const [upload_url, verify_url] = await Promise.all([
    getSignedUrl(input.client, new PutObjectCommand({ Bucket: input.bucket, Key: input.key, ContentType: input.contentType, CacheControl: 'private, no-store' }), { expiresIn: 600 }),
    getSignedUrl(input.client, new GetObjectCommand({ Bucket: input.bucket, Key: input.key }), { expiresIn: 600 }),
  ]);
  return requestTransfer(input.orgId, { operation: 'copy', source_url: input.sourceUrl, upload_url, verify_url, content_type: input.contentType,
    expected_sha256: input.expectedSha256, expected_size: input.expectedSize });
}
export async function verifyWithTransferService(orgId: string, client: S3Client, bucket: string, key: string, expectedSha256?: string, expectedSize?: number) {
  const source_url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 600 });
  return requestTransfer(orgId, { operation: 'verify', source_url, expected_sha256: expectedSha256, expected_size: expectedSize });
}
