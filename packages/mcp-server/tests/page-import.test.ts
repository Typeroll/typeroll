import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pageTools } from '../src/tools/pages.js';

it('exposes import creation without accepting caller provenance', async () => {
  const tool = pageTools.find(tool => tool.name === 'create_page')!;
  const input = z.object(tool.inputSchema).parse({ title: 'Example', write_mode: 'import', fields: { enabled: true } });
  const post = vi.fn().mockResolvedValue({ page: { id: 'example' } });
  await tool.handler(input, { siteId: 'site', client: { post } as never });
  expect(post).toHaveBeenCalledWith('site', 'pages', input, undefined);
  expect(() => z.object(tool.inputSchema).parse({ title: 'Example', write_mode: 'owner' })).toThrow();
});
it('round-trips sparse imports and authority reads with exact version and paths', async () => {
  const read = pageTools.find(tool => tool.name === 'read_page_authority')!;
  const write = pageTools.find(tool => tool.name === 'import_page_fields')!;
  const get = vi.fn().mockResolvedValue({ revision: 'a'.repeat(64) });
  const post = vi.fn().mockResolvedValue({ changed: true });
  const client = { get, post } as never;
  const path = 'programs/@one~1a~0b/legacy_anchor';
  await read.handler(z.object(read.inputSchema).parse({ page_id: 'example', paths: [path], version: 'migration' }), { siteId: 'site', client });
  expect(get).toHaveBeenCalledWith('site', 'pages/example/authority', { paths: JSON.stringify([path]), version: 'migration' });
  const body = { base_revision: 'a'.repeat(64), changes: [{ path, value: null }], import_run_id: 'migration-1' };
  await write.handler(z.object(write.inputSchema).parse({ page_id: 'example', version: 'migration', ...body }), { siteId: 'site', client });
  expect(post).toHaveBeenCalledWith('site', 'pages/example/import', body, { version: 'migration' });
  expect(() => z.object(write.inputSchema).parse({ page_id: 'example', ...body, changes: [{ path, value: true, source: 'owner' }] })).toThrow();
  const schema = z.toJSONSchema(z.object(write.inputSchema), { target: 'draft-7', io: 'input' });
  expect(JSON.stringify(schema)).toContain('base_revision');
});

it('exposes sharing text overrides in strict create and update schemas', async () => {
  const metadata = { og_title: 'Share this', og_description: 'Sharing description', og_image: 'https://example.com/share.jpg' };
  for (const [name, data] of [['create_page', { title: 'Document', ...metadata }], ['update_page', { page_id: 'example', patch: metadata }]] as const) {
    const tool = pageTools.find(tool => tool.name === name)!;
    const input = z.strictObject(tool.inputSchema).parse(data);
    expect(input).toEqual(data);
    const schema = z.toJSONSchema(z.strictObject(tool.inputSchema), { target: 'draft-7', io: 'input' });
    expect(JSON.stringify(schema)).toContain('og_title');
    expect(JSON.stringify(schema)).toContain('og_description');
  }
});
