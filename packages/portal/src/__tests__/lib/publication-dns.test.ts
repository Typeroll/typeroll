import { afterEach, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { publicationResponse, publicIpv4Answers } from '../../lib/deploy/public-response';
const mocked = vi.hoisted(() => ({ lookup: null as any, close: vi.fn(async () => {}) }));
vi.mock('undici', () => ({ Agent: class { constructor(options: any) { mocked.lookup = options.connect.lookup; } close = mocked.close; } }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const url = new URL('https://new-site.example.com/page/');
it('pins a negative-DNS fallback to independently checked public addresses', async () => {
  vi.spyOn(dns, 'lookup').mockRejectedValue(Object.assign(Error('missing'), { code: 'ENOTFOUND' }));
  const request = vi.fn(async (target: URL, init: any) => {
    if (target.hostname === 'cloudflare-dns.com') {
      expect(target.searchParams.get('name')).toBe(url.hostname);
      expect(init.headers).toEqual({ Accept: 'application/dns-json' });
      return Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] });
    }
    expect(target.href).toBe(url.href);
    expect(init.redirect).toBe('manual'); expect(init.dispatcher).toBeDefined();
    const resolved = vi.fn(); mocked.lookup(url.hostname, { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }]);
    const rejected = vi.fn(); mocked.lookup('other.example.com', {}, rejected);
    expect(rejected.mock.calls[0][0]).toBeInstanceOf(Error);
    return new Response('new public bytes');
  });
  vi.stubGlobal('fetch', request);
  const handle = await publicationResponse(url, { method: 'GET' });
  try { expect(await handle.response.text()).toBe('new public bytes'); }
  finally { await handle.close(); }
  expect(request).toHaveBeenCalledTimes(2);
  expect(mocked.close).toHaveBeenCalled();
});

it('never connects to the site when fallback DNS contains a private address', async () => {
  vi.spyOn(dns, 'lookup').mockRejectedValue(Object.assign(Error('missing'), { code: 'ENOTFOUND' }));
  const request = vi.fn(async (_target: URL) => Response.json({ Status: 0, Answer: [{ type: 1, data: '169.254.169.254' }] }));
  vi.stubGlobal('fetch', request);
  await expect(publicationResponse(url, { method: 'HEAD' })).rejects.toThrow('public host');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0].hostname).toBe('cloudflare-dns.com');
});

it('does not retry certificate failures through another resolver', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
  const request = vi.fn(async () => { throw Object.assign(Error('TLS failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); });
  vi.stubGlobal('fetch', request);
  await expect(publicationResponse(url, { method: 'HEAD' })).rejects.toThrow('TLS failed');
  expect(request).toHaveBeenCalledTimes(1);
});

it('does not replace a private system DNS answer with a public resolver answer', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  await expect(publicationResponse(url, { method: 'HEAD' })).rejects.toThrow('non-public');
  expect(request).not.toHaveBeenCalled();
});

it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '2130706433'])('rejects unsafe public-resolver answer %s', address => {
  expect(() => publicIpv4Answers({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }, { type: 1, data: address }] })).toThrow();
});

it('does not treat NXDOMAIN, empty answers or oversized answer sets as ready', () => {
  for (const data of [{ Status: 3 }, { Status: 0, Answer: [] }, { Status: 0, Answer: Array.from({ length: 9 }, (_, i) => ({ type: 1, data: `1.1.1.${i + 1}` })) }]) expect(() => publicIpv4Answers(data)).toThrow();
});
