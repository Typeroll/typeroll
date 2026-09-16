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
