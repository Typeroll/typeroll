import { afterEach, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { publicationResponse } from '../../lib/deploy/public-response';

// Exercise the installed dispatcher's real handler contract without opening a socket.
vi.mock('undici', async original => {
  const actual = await original<typeof import('undici')>();
  return { ...actual, Agent: class extends actual.MockAgent {
    constructor() {
      super(); this.disableNetConnect();
      this.get('https://new-site.example.com').intercept({ path: '/page/', method: 'GET' }).reply(200, 'verified static bytes');
    }
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses an HTTP client compatible with the pinned dispatcher', async () => {
  vi.spyOn(dns, 'lookup').mockRejectedValue(Object.assign(Error('negative DNS'), { code: 'ENOTFOUND' }));
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: URL, init?: RequestInit) => url.hostname === 'cloudflare-dns.com'
    ? Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] }) : nativeFetch(url, init));
  const handle = await publicationResponse(new URL('https://new-site.example.com/page/'), { method: 'GET' });
  try { expect(await handle.response.text()).toBe('verified static bytes'); }
  finally { await handle.close(); }
});
