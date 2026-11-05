import { afterEach, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { missingDns, publicationResponse } from '../../lib/deploy/public-response';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const url = new URL('https://new-site.example.com/page/');

it('reads a public publication URL without following redirects', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as never);
  const request = vi.fn(async (_target: URL, init: RequestInit) => {
    expect(init.redirect).toBe('manual');
    return new Response('public bytes');
  });
  vi.stubGlobal('fetch', request);
  const handle = await publicationResponse(url, { method: 'GET' });
  try { expect(await handle.response.text()).toBe('public bytes'); }
  finally { await handle.close(); }
  expect(request).toHaveBeenCalledTimes(1);
});

it('reports a missing host as ENOTFOUND without fetching', async () => {
  vi.spyOn(dns, 'lookup').mockRejectedValue(Object.assign(Error('missing'), { code: 'ENOTFOUND' }));
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  const error = await publicationResponse(url, { method: 'HEAD' }).catch(value => value);
  expect(missingDns(error)).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it('never requests a host with a private answer', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  await expect(publicationResponse(url, { method: 'HEAD' })).rejects.toThrow('non-public');
  expect(request).not.toHaveBeenCalled();
});

it('refuses writes and passes transport failures through', async () => {
  await expect(publicationResponse(url, { method: 'POST' })).rejects.toThrow('read-only');
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as never);
  vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(Error('TLS failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); }));
  await expect(publicationResponse(url, { method: 'HEAD' })).rejects.toThrow('TLS failed');
});
