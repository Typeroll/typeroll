import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../src/client.js';
import { pageTools } from '../src/tools/pages.js';

const tool = (name: string) => pageTools.find(entry => entry.name === name)!;
const source = { page: { title: 'Tack', content_type: 'page', content_mode: 'blocks', blocks: [], status: 'published' } };

it('documents the address conflict rule on create_page and clone_page', () => {
  for (const name of ['create_page', 'clone_page']) {
    expect(tool(name).description).toContain('slug_in_use');
    expect(tool(name).description).toContain('slug_adjusted');
  }
});

it('clone_page passes a named slug through, including the homepage slug, and omits an absent one', async () => {
  const clone = tool('clone_page');
  for (const [slug, expected] of [['tack', 'tack'], ['', ''], [undefined, undefined]] as const) {
    const post = vi.fn().mockResolvedValue({ page: { id: 'x' } });
    const get = vi.fn().mockResolvedValue(source);
    const args = z.object(clone.inputSchema!).parse({ source_page_id: 'tack', title: 'Tack igen', ...(slug === undefined ? {} : { slug }) });
    await clone.handler(args as never, { client: { get, post } as never, siteId: 'site' });
    const body = post.mock.calls[0][2] as Record<string, unknown>;
    if (expected === undefined) expect(body).not.toHaveProperty('slug');
    else expect(body.slug).toBe(expected);
  }
});

it('surfaces a slug_in_use conflict with the existing page id and path', async () => {
  const create = tool('create_page');
  const conflict = { error: 'Slug "tack" is already in use', code: 'slug_in_use', details: { page_id: 'tack', path: '/tack' } };
  const post = vi.fn().mockRejectedValue(new ApiError(409, conflict));
  const result = await create.handler(z.object(create.inputSchema!).parse({ title: 'Tack', slug: 'tack' }) as never, { client: { post } as never, siteId: 'site' });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 409, body: conflict });
});
