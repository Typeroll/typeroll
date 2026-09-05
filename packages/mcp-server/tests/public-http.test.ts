import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { fetchPublicSource } from '../src/public-http.js';
import { mediaTools } from '../src/tools/media.js';

let calls: Array<{ url: URL; options: RequestOptions }>;
let replies: Array<{ status: number; headers?: Record<string, string>; body?: string }>;
beforeEach(() => {
  calls = [];
  replies = [{ status: 200, body: 'public bytes' }];
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const request = ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls.push({ url, options });
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      queueMicrotask(() => {
        const reply = replies.shift()!;
        const incoming = Object.assign(new PassThrough(), { statusCode: reply.status, headers: reply.headers ?? {} });
        callback(incoming as IncomingMessage);
        incoming.end(reply.body ?? '');
      });
    };
    return req;
  }) as typeof http.request;
  vi.spyOn(http, 'request').mockImplementation(request);
  vi.spyOn(https, 'request').mockImplementation(request);
});
afterEach(() => vi.restoreAllMocks());

it.each([
  'http://127.0.0.1/private', 'http://127.1/', 'http://0x7f000001/',
  'http://10.0.0.1/', 'https://169.254.169.254/', 'https://192.168.1.2/',
  'http://100.64.0.1/', 'http://localhost./', 'http://internal.local/',
  'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
  'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[2002:7f00:1::]/',
  'file:///etc/passwd', 'data:text/plain,private', 'ftp://public.example/file',
  'https://user:password@public.example/',
])('rejects unsafe source %s before making a request', async (url) => {
  await expect(fetchPublicSource(url)).rejects.toThrow(/public/);
  expect(calls).toHaveLength(0);
});

it('rejects DNS records containing a private address even alongside a public address', async () => {
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] as never);
  await expect(fetchPublicSource('https://source.example/image')).rejects.toThrow(/public/);
  expect(calls).toHaveLength(0);
});

it('pins DNS for the connection while preserving the original HTTP and TLS hostname', async () => {
  vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
  expect(await (await fetchPublicSource('https://source.example/image')).text()).toBe('public bytes');
  const { url, options } = calls[0]!;
  expect(url.hostname).toBe('source.example');
  expect(options.agent).toBe(false);
  const one = vi.fn();
  const all = vi.fn();
  options.lookup!('source.example', {}, one);
  options.lookup!('source.example', { all: true }, all);
  expect(one).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  expect(dns.lookup).toHaveBeenCalledTimes(1);
});

it.each(['http://127.0.0.1/private', 'http://[::ffff:10.0.0.1]/', 'file:///private'])('rejects redirect to %s', async (location) => {
  replies = [{ status: 302, headers: { location } }];
  await expect(fetchPublicSource('https://source.example/image')).rejects.toThrow(/public/);
  expect(calls).toHaveLength(1);
});

it('validates each public redirect and supports relative locations', async () => {
  replies = [{ status: 302, headers: { location: '/final' } }, { status: 200, body: 'final bytes' }];
  expect(await (await fetchPublicSource('https://source.example/start')).text()).toBe('final bytes');
  expect(calls.map((call) => call.url.pathname)).toEqual(['/start', '/final']);
  expect(dns.lookup).toHaveBeenCalledTimes(2);
});

it('bounds redirect loops', async () => {
  replies = Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/loop' } }));
  await expect(fetchPublicSource('https://source.example/loop')).rejects.toThrow(/too many redirects/);
  expect(calls).toHaveLength(6);
});

it.each(['https://8.8.8.8/image', 'https://[2001:4860:4860::8888]/image'])(
  'allows a public IP literal without another DNS lookup: %s', async (url) => {
    expect(await (await fetchPublicSource(url)).text()).toBe('public bytes');
    expect(dns.lookup).not.toHaveBeenCalled();
  },
);

it.each(['upload_media_from_url', 'upload_media_batch_from_urls'])(
  'enforces the public destination boundary through %s', async (name) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('synthetic internal bytes'));
    const post = vi.fn().mockResolvedValue({ upload_url: 'https://storage.example/object', media_id: 'test' });
    const tool = mediaTools.find((entry) => entry.name === name)!;
    const input = { source_url: 'http://127.0.0.1/internal', filename: 'test.pdf', content_type: 'application/pdf' };
    const result = await tool.handler(name.includes('batch') ? { items: [input] } : input, { client: { post }, siteId: 'test' } as never);
    if (name.includes('batch')) expect(JSON.parse(result.content[0]!.text)).toMatchObject({ succeeded: 0, failed: 1 });
    else expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  },
);
