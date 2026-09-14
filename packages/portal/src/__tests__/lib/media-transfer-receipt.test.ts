import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { copyWithTransferService } from '../../lib/media/remote-transfer';
vi.mock('../../lib/media/transfer-service', () => ({ customerTransferService: vi.fn(async () => ({ url: 'https://customer.example.com/transfer', secret: 'synthetic-receipt-secret' })) }));
const sign = (text: string) => createHmac('sha256', 'synthetic-receipt-secret').update(text).digest('hex');
const client = new S3Client({ region: 'auto', forcePathStyle: true, endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, requestChecksumCalculation: 'WHEN_REQUIRED' });
const copy = () => copyWithTransferService({ orgId: 'org', sourceUrl: 'https://source.example.com/image.png', client, bucket: 'originals', key: 'incoming/image.png', contentType: 'image/png', expectedSha256: 'a'.repeat(64), expectedSize: 3 });
beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => {}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(['valid', 'forged', 'replay', 'different-file', 'oversized-response'])('authenticates %s receipts without fetching any object in the portal', async kind => {
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(url).toBe('https://customer.example.com/transfer');
    const job = JSON.parse(options.body);
    expect(options.headers['x-typeroll-signature']).toBe(sign(options.body));
    expect(job.source_url).toBe('https://source.example.com/image.png');
    expect(new URL(job.upload_url).pathname).toContain('/originals/incoming/image.png');
    let text = JSON.stringify({ protocol: 1, id: kind === 'replay' ? 'prior-request' : job.id, sha256: kind === 'different-file' ? 'b'.repeat(64) : 'a'.repeat(64), size: 3, etag: '"verified"' });
    if (kind === 'oversized-response') text = 'x'.repeat(2049);
    return new Response(text, { headers: { 'x-typeroll-signature': kind === 'forged' ? '0'.repeat(64) : sign(text) } });
  }));
  if (kind === 'valid') await expect(copy()).resolves.toMatchObject({ sha256: 'a'.repeat(64), size: 3 });
  else await expect(copy()).rejects.toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});
