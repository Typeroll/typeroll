import { afterEach, expect, it, vi } from 'vitest';
import { connectionFailure } from '../../lib/publishing/http';
import { ConnectionError } from '../../lib/publishing/connections';
import { ProviderError } from '../../lib/publishing/providers.mjs';

afterEach(() => { vi.restoreAllMocks(); });
const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(call => JSON.parse(String(call[0])));

it('records why an unexpected error became a generic 502, without signed queries or tokens', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const error = Object.assign(new Error('GET https://bucket.r2.fixture.invalid/builds/key?X-Amz-Signature=secret failed with Bearer abc.def'), { name: 'S3ServiceException', code: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  const response = connectionFailure(error, { route: 'build_runner', org_id: 'org', action: 'claim' });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'Publishing connection failed. Check the account setup and try again.' });
  const [entry] = logged(spy);
  expect(entry).toMatchObject({ event: 'publishing_connection_failed', route: 'build_runner', org_id: 'org', action: 'claim', name: 'S3ServiceException', code: 'NoSuchKey', http_status: 404 });
  expect(entry.message).toBe('GET https://bucket.r2.fixture.invalid/builds/key?[redacted] failed with Bearer [redacted]');
  expect(JSON.stringify(entry)).not.toMatch(/secret|abc\.def/);
});

it('logs provider failures but not the errors that already explain themselves', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(connectionFailure(new ProviderError('cloudflare', 500, [10000])).status).toBe(502);
  expect(logged(spy)[0]).toMatchObject({ event: 'publishing_connection_failed', name: 'ProviderError', provider_codes: [10000] });
  spy.mockClear();
  expect(connectionFailure(new ConnectionError('Build storage changed.', 409)).status).toBe(409);
  expect(spy).not.toHaveBeenCalled();
});
