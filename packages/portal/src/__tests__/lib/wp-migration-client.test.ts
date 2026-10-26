import { afterEach, expect, it, vi } from 'vitest';
import { WPClient } from '../../lib/wp/client';
import { WPHelperClient } from '../../lib/wp/helper-client';

afterEach(() => vi.unstubAllGlobals());

it.each(['rest', 'helper'])('reads every declared %s page beyond the former silent cap', async kind => {
  const fetchMock = vi.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json([{ id: page }], { headers: { 'X-WP-TotalPages': '101' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const items = kind === 'rest' ? await new WPClient('https://source.example').listPosts()
    : await new WPHelperClient('https://source.example', 'test-only-key').listItems('post');
  expect(items).toHaveLength(101);
  expect(items.at(-1)?.id).toBe(101);
  expect(fetchMock).toHaveBeenCalledTimes(101);
});

it.each(['rest', 'helper'])('rejects incomplete %s pagination and provider errors instead of returning partial success', async kind => {
  const read = () => kind === 'rest' ? new WPClient('https://source.example').listPosts()
    : new WPHelperClient('https://source.example', 'test-only-key').listItems('post');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([], { headers: { 'X-WP-TotalPages': '2' } })));
  await expect(read()).rejects.toThrow('Incomplete WordPress export');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })));
  await expect(read()).rejects.toThrow('400');
});

it.each(['rest', 'helper'])('refuses an unbounded %s page count declared by the source', async kind => {
  const fetchMock = vi.fn(async () => Response.json([{ id: 1 }], { headers: { 'X-WP-TotalPages': '100000' } }));
  vi.stubGlobal('fetch', fetchMock);
  const read = kind === 'rest' ? new WPClient('https://source.example').listPosts()
    : new WPHelperClient('https://source.example', 'test-only-key').listItems('post');
  await expect(read).rejects.toThrow(/at most 1000 pages/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('never follows a source redirect to a private or metadata address', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/' } }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(new WPClient('https://source.example').siteInfo()).rejects.toThrow(/public host/);
  await expect(new WPClient('http://127.0.0.1:8080').siteInfo()).rejects.toThrow(/public host/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps the helper key on same-site upgrades and drops it on cross-site redirects', async () => {
  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.protocol === 'http:') return new Response(null, { status: 301, headers: { location: url.href.replace('http:', 'https:') } });
    if (url.hostname === 'source.example') return new Response(null, { status: 302, headers: { location: 'https://collector.example/x' } });
    return Response.json({ plugin_version: '1.0.0' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await new WPHelperClient('http://source.example', 'test-only-key').info().catch(() => null);
  const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-typeroll-key'));
  expect(keys).toEqual(['test-only-key', 'test-only-key', null]);
});
