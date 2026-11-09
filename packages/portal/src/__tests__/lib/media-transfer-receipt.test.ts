import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { S3Client } from '../../lib/net/s3';
import { copyWithTransferService, sourceUrlCandidates } from '../../lib/media/remote-transfer';
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
it('tries the NFC and NFD forms of a non-ASCII source path when the source answers that the file is missing', async () => {
  const nfd = 'https://source.example.com/2020/07/T%C3%A4rkeit%C3%A4.jpg'.replace(/%C3%A4/g, 'a%CC%88');
  const tried: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const job = JSON.parse(options.body);
    tried.push(job.source_url);
    const text = job.source_url === nfd
      ? JSON.stringify({ protocol: 1, id: job.id, sha256: 'a'.repeat(64), size: 3, etag: '"verified"' })
      : JSON.stringify({ error: 'media_source_unavailable' });
    return new Response(text, { status: job.source_url === nfd ? 200 : 422, headers: { 'x-typeroll-signature': sign(text) } });
  }));
  await expect(copyWithTransferService({ orgId: 'org', sourceUrl: 'https://source.example.com/2020/07/Tärkeitä.jpg', client, bucket: 'originals', key: 'incoming/t.jpg', contentType: 'image/jpeg' }))
    .resolves.toMatchObject({ size: 3 });
  expect(tried).toEqual(['https://source.example.com/2020/07/Tärkeitä.jpg', nfd]);
});
it('keeps one candidate for ASCII paths and the given form first', () => {
  expect(sourceUrlCandidates('https://source.example.com/a%20b.png?x=1')).toEqual(['https://source.example.com/a%20b.png?x=1']);
  expect(sourceUrlCandidates('https://source.example.com/k%C3%A4ytt%C3%B6.pdf')).toEqual(['https://source.example.com/k%C3%A4ytt%C3%B6.pdf', 'https://source.example.com/ka%CC%88ytto%CC%88.pdf']);
  expect(sourceUrlCandidates('https://source.example.com/%E0%A4%A.png')).toEqual(['https://source.example.com/%E0%A4%A.png']);
});

/** Runs a copy whose retries wait on timers, without waiting for them in real time. */
async function settle<T>(promise: Promise<T>) {
  let done = false;
  const outcome = promise.then(value => ({ value }), error => ({ error })).finally(() => { done = true; });
  // Backoff timers are set after real asynchronous work (request signing), so advance until the copy settles.
  for (let step = 0; step < 1000 && !done; step++) { await new Promise(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(250); }
  return outcome as Promise<{ value?: T; error?: any }>;
}
const failureLogs = () => vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(String(line)));

it('retries a Cloudflare HTML error page over 2 KB and fails with a code that keeps the upstream status', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const { remoteMediaTransfers } = await import('../../lib/media/transfer');
    const congested = vi.spyOn(remoteMediaTransfers, 'congested');
    const page = `<!DOCTYPE html><html><head><title>Worker exceeded resource limits | Cloudflare</title></head><body>${'Error 1102 '.repeat(800)}</body></html>`;
    expect(page.length).toBeGreaterThan(2048);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page, { status: 503, headers: { 'content-type': 'text/html' } })));
    const { error } = await settle(copy());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({ status: 503, code: 'media_transfer_unavailable', details: { upstream_status: 503, worker_code: null } });
    expect(error.message).toContain('HTTP 503');
    expect(congested).toHaveBeenCalledTimes(3);
    const logs = failureLogs();
    expect(logs.filter(log => log.event === 'media_transfer_retry')).toEqual([
      expect.objectContaining({ attempt: 1, reason: 'http_503', upstream_status: 503, worker_code: null }),
      expect.objectContaining({ attempt: 2, reason: 'http_503', upstream_status: 503, worker_code: null }),
    ]);
    expect(logs.find(log => log.event === 'media_transfer_failed')).toMatchObject({ attempts: 3, upstream_status: 503, code: 'media_transfer_unavailable' });
  } finally { vi.useRealTimers(); }
});

it.each(['media_source_temporarily_unavailable', 'media_transfer_interrupted', 'media_transfer_timeout', 'media_transfer_busy', 'media_destination_unavailable'])(
  'keeps the transfer Worker code %s after retrying it', async code => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: code }, { status: 503, headers: { 'Retry-After': '2' } })));
      const { error } = await settle(copy());
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(error).toMatchObject({ status: 503, code, details: { upstream_status: 503, worker_code: code } });
      expect(error.message).not.toMatch(/Retry the migration/);
      expect(failureLogs().filter(log => log.event === 'media_transfer_retry').map(log => log.reason)).toEqual([`http_503:${code}`, `http_503:${code}`]);
    } finally { vi.useRealTimers(); }
  });

it('does not retry a refused source and reports it as a permanent failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'media_source_unavailable' }, { status: 422 })));
  await expect(copy()).rejects.toMatchObject({ status: 422, code: 'media_source_unavailable', details: { upstream_status: 422, worker_code: 'media_source_unavailable' } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('recovers when a retried 5xx is followed by a valid receipt', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (calls++ === 0) return new Response('<html>'.padEnd(4096, 'x'), { status: 502 });
      const text = JSON.stringify({ protocol: 1, id: JSON.parse(options.body).id, sha256: 'a'.repeat(64), size: 3, etag: '"verified"' });
      return new Response(text, { headers: { 'x-typeroll-signature': sign(text) } });
    }));
    const { value } = await settle(copy());
    expect(value).toMatchObject({ size: 3 });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
