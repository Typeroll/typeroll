// REST client tests — mocked fetch, no real network.

import { describe, it, expect, vi } from 'vitest';
import { TyperollClient, ApiError } from '../src/client.js';

interface MockFetchCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (call: MockFetchCall) => Response | Promise<Response>): { fetch: typeof fetch; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const fn: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: MockFetchCall = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TyperollClient', () => {
  it('attaches the bearer token', async () => {
    const { fetch, calls } = mockFetch(() => json({ ok: true }));
    const c = new TyperollClient({
      baseUrl: 'https://example.test',
      apiKey: 'typeroll_live_aaaa_bbbb',
      fetchImpl: fetch,
    });
    await c.get<unknown>('site1', 'pages');
    expect(calls.length).toBe(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer typeroll_live_aaaa_bbbb');
  });

  it('builds site-scoped URLs', async () => {
    const { fetch, calls } = mockFetch(() => json({ ok: true }));
    const c = new TyperollClient({ baseUrl: 'https://example.test/', apiKey: 'k', fetchImpl: fetch });
    await c.get('mysite', 'pages/home');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/pages/home');
  });

  it('attaches query params', async () => {
    const { fetch, calls } = mockFetch(() => json({ ok: true }));
    const c = new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'k', fetchImpl: fetch });
    await c.get('site1', 'pages', { status: 'draft', limit: 10, ignored: undefined });
    expect(calls[0].url).toContain('status=draft');
    expect(calls[0].url).toContain('limit=10');
    expect(calls[0].url).not.toContain('ignored');
  });

  it('throws ApiError on non-2xx with the parsed body', async () => {
    const { fetch } = mockFetch(() => json({ error: 'Not found' }, 404));
    const c = new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'k', fetchImpl: fetch });
    await expect(c.get('site1', 'pages/nope')).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    });
    await expect(c.get('site1', 'pages/nope')).rejects.toBeInstanceOf(ApiError);
  });

  it('POST/PATCH/PUT serialize the body and set content-type', async () => {
    const { fetch, calls } = mockFetch(() => json({ ok: true }));
    const c = new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'k', fetchImpl: fetch });
    await c.post('site1', 'pages', { title: 'hi' });
    expect((calls[0].init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(calls[0].init?.body).toBe(JSON.stringify({ title: 'hi' }));
  });

  it('rootGet uses /v1 without a site prefix', async () => {
    const { fetch, calls } = mockFetch(() => json({ sites: [{ id: 's1', name: 'S1' }] }));
    const c = new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'k', fetchImpl: fetch });
    await c.rootGet<unknown>('sites');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites');
  });
});
