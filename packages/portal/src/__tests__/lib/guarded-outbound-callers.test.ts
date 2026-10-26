import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Every request below must reach the network through lib/net/safe-fetch, which
// pins the connection to the address it validated. The wrapper records the
// policy and then performs the request unchanged.
const guarded = vi.hoisted(() => [] as Array<{ url: string; policy: Record<string, unknown> }>);
vi.mock('../../lib/net/safe-fetch', async (load) => {
  const actual = await load<typeof import('../../lib/net/safe-fetch')>();
  return {
    ...actual,
    safeFetch: (input: string | URL, init?: RequestInit, policy: Record<string, unknown> = {}) => {
      guarded.push({ url: String(input), policy: { ...policy } });
      return actual.safeFetch(input, init, policy);
    },
    createSafeFetch: (policy: Parameters<typeof actual.createSafeFetch>[0]) => {
      const fetcher = actual.createSafeFetch(policy);
      return ((input: RequestInfo | URL, init?: RequestInit) => {
        guarded.push({ url: String(input), policy: { ...policy } });
        return fetcher(input, init);
      }) as typeof fetch;
    },
  };
});
vi.mock('../../lib/extensions/public-http', async (load) => ({ ...await load<object>(), assertPublicDestination: vi.fn(async () => {}) }));
vi.mock('../../lib/publishing/connections', () => ({
  ConnectionError: class extends Error {},
  getConnection: vi.fn(async () => ({ cloudflare: { account_id: 'acct', public_bucket: 'public' }, revision: 'r1' })),
}));
// An externally connected media domain: Typeroll only proves the public bytes.
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: vi.fn(async () => async () => ({ enabled: true })) }));
vi.mock('../../lib/publishing/domain-config', () => ({ getOrganizationDomains: vi.fn(async () => ({ media_host: null, dns_mode: 'external' })) }));

import { requestApprovedAdmin } from '../../lib/extensions/admin-request';
import { verifyRedirectHost } from '../../lib/publishing/redirect-hosts';
import { preparePublicMediaDomains } from '../../lib/publishing/media-domain';
import { probePublication } from '../../lib/deploy/availability';
import { verifyStaticResponse } from '../../lib/builds/verification';

const network = vi.fn<typeof fetch>();
beforeEach(() => { guarded.length = 0; network.mockReset(); vi.stubGlobal('fetch', network); });
afterEach(() => vi.unstubAllGlobals());

const noRedirects = expect.objectContaining({ maxRedirects: 0 });

it('sends approved app requests through the guarded client', async () => {
  network.mockResolvedValue(Response.json({ ok: true }));
  const result = await requestApprovedAdmin(new URL('https://app.example/admin/settings'),
    { method: 'GET', page_id: 'settings', path: '/admin/settings' }, 'token', 'https://cms.example');
  expect(result).toEqual({ status: 200, data: { ok: true } });
  expect(guarded).toEqual([{ url: 'https://app.example/admin/settings', policy: noRedirects }]);
});

it('checks redirect hosts through the guarded client and reads the redirect itself', async () => {
  const path = '/.well-known/typeroll/publication.json?typeroll_redirect_check=abc';
  network.mockResolvedValue(new Response(null, { status: 301, headers: { location: `https://www.example.com${path}` } }));
  expect(await verifyRedirectHost('example.com', 'www.example.com', 'abc')).toEqual({ ok: true, status: 301, location: `https://www.example.com${path}` });
  expect(guarded).toEqual([{ url: `https://example.com${path}`, policy: noRedirects }]);
});

it('verifies public media bytes through the guarded client', async () => {
  network.mockImplementation(async () => new Response('media bytes'));
  const sha256 = createHash('sha256').update('media bytes').digest('hex');
  expect(await preparePublicMediaDomains('org', { account_id: 'acct', public_bucket: 'public', media_host: 'media.example.com',
    website_host: 'www.example.com', site_prefix: 'site', entries: [{ cdn_url: 'https://media.example.com/a.jpg', sha256, aliases: [] }] })).toBe(true);
  expect(guarded).toEqual([{ url: 'https://media.example.com/a.jpg', policy: expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }) }]);
});

it('probes publications and verifies static bytes through the guarded client', async () => {
  network.mockImplementation(async () => new Response('page', { headers: { 'x-typeroll-publication': 'pub' } }));
  expect(await probePublication('https://www.example.com', '/', 'pub', { validate: async () => {} })).toBe(true);
  const sha256 = createHash('sha256').update('page').digest('hex');
  expect(await verifyStaticResponse('https://www.example.com', { route: '/about', status: 200, sha256 }, { validate: async () => {} })).toBe(true);
  expect(guarded).toEqual([
    { url: 'https://www.example.com/', policy: noRedirects },
    { url: 'https://www.example.com/about', policy: noRedirects },
  ]);
});
