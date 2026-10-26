import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PRIVATE_NETWORK_FETCH_ENV,
  createValidatingLookup,
  isAllowedOutboundAddress,
  migrationSourcePolicy,
  parseOutboundUrl,
  resolveOutboundAddresses,
  safeFetch,
  sameSourceSite,
} from '../../lib/net/safe-fetch';

const optIn = migrationSourcePolicy();

afterEach(() => {
  delete process.env[PRIVATE_NETWORK_FETCH_ENV];
  vi.unstubAllGlobals();
});

describe('parseOutboundUrl', () => {
  it.each([
    'ftp://example.com/',
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://localhost/',
    'https://metadata.google.internal/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://[::ffff:a9fe:a9fe]/',
    'https://[::ffff:10.0.0.1]/',
    'https://[64:ff9b::a9fe:a9fe]/',
    'https://[2002:a9fe:a9fe::]/',
    'https://100.64.0.1/',
    'https://0.0.0.0/',
  ])('rejects %s by default', (raw) => {
    expect(() => parseOutboundUrl(raw)).toThrow();
  });

  it('accepts public HTTPS and, when allowed, plain HTTP', () => {
    expect(parseOutboundUrl('https://example.com/a').href).toBe('https://example.com/a');
    expect(parseOutboundUrl('http://example.com/a', { allowHttp: true }).protocol).toBe('http:');
    expect(parseOutboundUrl('https://[2606:4700:4700::1111]/').hostname).toBe('[2606:4700:4700::1111]');
  });

  it('relaxes only private ranges, and only for opted-in migration policies', () => {
    expect(() => parseOutboundUrl('http://10.0.0.5/', optIn)).toThrow(/public host/);
    process.env[PRIVATE_NETWORK_FETCH_ENV] = '1';
    expect(parseOutboundUrl('http://10.0.0.5/', optIn).hostname).toBe('10.0.0.5');
    expect(parseOutboundUrl('http://intranet.local/', optIn).hostname).toBe('intranet.local');
    expect(() => parseOutboundUrl('https://10.0.0.5/')).toThrow(/public host/);
    expect(() => parseOutboundUrl('http://169.254.169.254/', optIn)).toThrow(/public host/);
    expect(() => parseOutboundUrl('http://[::ffff:a9fe:a9fe]/', optIn)).toThrow(/public host/);
    expect(isAllowedOutboundAddress('fe80::1', optIn)).toBe(false);
  });
});

describe('DNS validation used by the pinned connection', () => {
  const lookupOf = (...addresses: string[]) => vi.fn(async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('rejects a host when any answer is not public, including mapped IPv6', async () => {
    await expect(resolveOutboundAddresses('a.example', {}, lookupOf('8.8.8.8', '10.0.0.1'))).rejects.toThrow(/non-public/);
    await expect(resolveOutboundAddresses('a.example', {}, lookupOf('::ffff:169.254.169.254'))).rejects.toThrow(/non-public/);
    await expect(resolveOutboundAddresses('a.example', {}, lookupOf('64:ff9b::7f00:1'))).rejects.toThrow(/non-public/);
    await expect(resolveOutboundAddresses('a.example', {}, lookupOf('8.8.8.8'))).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  it('hands the socket exactly the addresses it validated', async () => {
    const lookup = lookupOf('203.0.113.7', '2606:4700::1');
    const validating = createValidatingLookup({}, lookup);
    const all = await new Promise<unknown>((resolve, reject) => validating('a.example', { all: true }, (error, address) => error ? reject(error) : resolve(address)));
    expect(all).toEqual([{ address: '203.0.113.7', family: 4 }, { address: '2606:4700::1', family: 6 }]);
    const v4 = await new Promise<unknown>((resolve, reject) => validating('a.example', { family: 4 }, (error, address) => error ? reject(error) : resolve(address)));
    expect(v4).toBe('203.0.113.7');
    expect(lookup).toHaveBeenCalledTimes(2);

    const rebinding = createValidatingLookup({}, lookupOf('127.0.0.1'));
    await expect(new Promise((resolve, reject) => rebinding('a.example', { all: true }, (error, address) => error ? reject(error) : resolve(address))))
      .rejects.toThrow(/non-public/);
  });
});

describe('safeFetch over the pinned transport', () => {
  let server: http.Server;
  let origin: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      hits.push(request.url ?? '');
      if (request.url === '/redirect-metadata') { response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); response.end(); return; }
      if (request.url === '/redirect-mapped') { response.writeHead(302, { location: 'http://[::ffff:7f00:1]/' }); response.end(); return; }
      if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); return; }
      if (request.url === '/hop') { response.writeHead(301, { location: '/ok' }); response.end(); return; }
      if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        for (let i = 0; i < 64; i++) response.write('x'.repeat(1024));
        response.end();
        return;
      }
      if (request.url === '/slow') { response.writeHead(200); response.write('a'); return; }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`ok ${request.headers.host}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

  it('never connects to a loopback host by default', async () => {
    hits.length = 0;
    await expect(safeFetch(`${origin}/`, {}, { allowHttp: true })).rejects.toThrow();
    await expect(safeFetch(origin.replace('localhost', '127.0.0.1') + '/', {}, { allowHttp: true })).rejects.toThrow(/public host/);
    expect(hits).toEqual([]);
  });

  it('reaches a private source only with the self-hosted opt-in', async () => {
    process.env[PRIVATE_NETWORK_FETCH_ENV] = '1';
    const response = await safeFetch(`${origin}/hop`, {}, optIn);
    expect(await response.text()).toMatch(/^ok localhost:/);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe(`${origin}/ok`);
  });

  it('validates every redirect hop, also with the opt-in', async () => {
    process.env[PRIVATE_NETWORK_FETCH_ENV] = '1';
    await expect(safeFetch(`${origin}/redirect-metadata`, {}, optIn)).rejects.toThrow(/public host/);
    delete process.env[PRIVATE_NETWORK_FETCH_ENV];
    await expect(safeFetch(`${origin}/redirect-mapped`, {}, { allowHttp: true })).rejects.toThrow();
    process.env[PRIVATE_NETWORK_FETCH_ENV] = '1';
    await expect(safeFetch(`${origin}/loop`, {}, { ...optIn, maxRedirects: 3 })).rejects.toThrow(/exceeded 3 redirects/);
    const manual = await safeFetch(`${origin}/redirect-metadata`, { redirect: 'manual' }, optIn);
    expect(manual.status).toBe(302);
  });

  it('caps streamed bodies and enforces the deadline', async () => {
    process.env[PRIVATE_NETWORK_FETCH_ENV] = '1';
    const large = await safeFetch(`${origin}/large`, {}, { ...optIn, maxBytes: 16 * 1024 });
    await expect(large.text()).rejects.toThrow(/exceeds 16384 bytes/);
    const slow = await safeFetch(`${origin}/slow`, {}, { ...optIn, timeoutMs: 200 });
    await expect(slow.text()).rejects.toThrow();
  });
});

describe('safeFetch with a replaced transport', () => {
  it('re-validates redirects and drops credentials across origins', async () => {
    const transport = vi.fn(async (input: string | URL, _init?: RequestInit) => new URL(String(input)).hostname === 'a.example'
      ? new Response(null, { status: 302, headers: { location: 'https://b.example/next' } })
      : new Response('done'));
    vi.stubGlobal('fetch', transport);
    const response = await safeFetch('https://a.example/', { headers: { Authorization: 'Bearer secret', 'X-Typeroll-Key': 'k', 'User-Agent': 'UA' } });
    expect(await response.text()).toBe('done');
    const secondHeaders = transport.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(secondHeaders).toEqual({ 'user-agent': 'UA' });

    transport.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://[::ffff:a9fe:a9fe]/' } }));
    transport.mockClear();
    await expect(safeFetch('https://a.example/')).rejects.toThrow(/public host/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('sameSourceSite', () => {
  it('accepts the source host with or without www and across http/https only', () => {
    expect(sameSourceSite('https://www.example.com/a', 'http://example.com')).toBe(true);
    expect(sameSourceSite('https://example.com:8443/a', 'https://example.com')).toBe(false);
    expect(sameSourceSite('http://10.0.0.1/a', 'https://example.com')).toBe(false);
    expect(sameSourceSite('https://evil.example/a', 'https://example.com')).toBe(false);
    expect(sameSourceSite('https://user@example.com/a', 'https://example.com')).toBe(false);
  });
});
