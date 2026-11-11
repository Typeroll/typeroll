// Polite reading of an old site during a migration: 429 and 503 are waited
// out as the host asks, with bounded retries and capped waits. Every delay is
// injected, so nothing here waits for real or reaches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { politeDelayMs, politeFetch, RequestPacer, retryAfterMs } from '../../lib/net/polite-fetch';
import { WPClient } from '../../lib/wp/client';
import { readSitemap } from '../../lib/wp/sitemap';

afterEach(() => vi.unstubAllGlobals());

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

function sequence(...responses: Array<() => Response>) {
  let call = 0;
  const request = vi.fn(async () => responses[Math.min(call++, responses.length - 1)]!());
  return request;
}

describe('Retry-After', () => {
  it('reads delta seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(retryAfterMs('7', now)).toBe(7000);
    expect(retryAfterMs('Wed, 11 Nov 2026 10:00:12 GMT', now)).toBe(12_000);
    expect(retryAfterMs('Wed, 11 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });

  it('caps the wait and otherwise backs off exponentially with jitter', () => {
    expect(politeDelayMs(1, '3600')).toBe(30_000);
    expect(politeDelayMs(1, '2', { maxDelayMs: 1000 })).toBe(1000);
    expect(politeDelayMs(1, null, { random: () => 0 })).toBe(500);
    expect(politeDelayMs(3, null, { random: () => 0.5 })).toBe(3000);
    expect(politeDelayMs(10, null, { random: () => 0.5 })).toBe(22_500);
  });
});

describe('politeFetch', () => {
  it('waits as long as a 429 asks before trying again', async () => {
    const { waits, sleep } = recorder();
    const request = sequence(
      () => new Response('slow down', { status: 429, headers: { 'Retry-After': '5' } }),
      () => new Response('ok'),
    );
    const response = await politeFetch(request, { sleep });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(waits).toEqual([5000]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('backs off after a 503 without Retry-After, then succeeds', async () => {
    const { waits, sleep } = recorder();
    const request = sequence(() => new Response(null, { status: 503 }), () => new Response(null, { status: 503 }), () => new Response('ok'));
    const response = await politeFetch(request, { sleep, random: () => 0.5 });
    expect(response.status).toBe(200);
    expect(waits).toEqual([750, 1500]);
  });

  it('returns the last refusal once the retries are used up', async () => {
    const { waits, sleep } = recorder();
    const request = sequence(() => new Response(null, { status: 429, headers: { 'Retry-After': '1' } }));
    const response = await politeFetch(request, { sleep, retries: 2 });
    expect(response.status).toBe(429);
    expect(request).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it('does not wait past a deadline, and leaves other statuses alone', async () => {
    const { waits, sleep } = recorder();
    const refused = await politeFetch(sequence(() => new Response(null, { status: 429, headers: { 'Retry-After': '20' } })), { sleep, now: () => 0, deadlineAt: 10_000 });
    expect(refused.status).toBe(429);
    const missing = sequence(() => new Response(null, { status: 404 }));
    expect((await politeFetch(missing, { sleep })).status).toBe(404);
    expect(missing).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('keeps consecutive requests of one loop apart', async () => {
    let clock = 0;
    const waits: number[] = [];
    const pacer = new RequestPacer(250, async (ms) => { waits.push(ms); clock += ms; }, () => clock);
    await pacer.wait();
    clock += 100;
    await pacer.wait();
    clock += 400;
    await pacer.wait();
    expect(waits).toEqual([150]);
  });
});

describe('migration fetchers back off', () => {
  it('WordPress REST client waits out a 429 and paces pages', async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '3' } });
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json([{ id: page }], { headers: { 'X-WP-TotalPages': '2' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const items = await new WPClient('https://source.example', { sleep, paceMs: 200, now: () => 0 }).listPosts();
    expect(items.map((item) => item.id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The host's 3 s, then the gap before the second page.
    expect(waits).toEqual([3000, 200]);
  });

  it('sitemap reads retry a 503 and record a host that keeps refusing', async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const busy = (async () => {
      calls++;
      return calls === 1 ? new Response(null, { status: 503 }) : new Response('<urlset><url><loc>https://source.example/a/</loc></url></urlset>');
    }) as unknown as typeof fetch;
    const read = await readSitemap('https://source.example/sitemap.xml', { fetchImpl: busy, polite: { sleep, random: () => 0, paceMs: 0 } });
    expect(read.urls.map((url) => url.loc)).toEqual(['https://source.example/a/']);
    expect(waits).toEqual([500]);

    const refusing = (async () => new Response(null, { status: 429 })) as unknown as typeof fetch;
    const refused = await readSitemap('https://source.example/sitemap.xml', { fetchImpl: refusing, polite: { sleep, retries: 1, paceMs: 0 } });
    expect(refused.errors).toEqual([{ url: 'https://source.example/sitemap.xml', error: 'HTTP 429' }]);
  });
});
