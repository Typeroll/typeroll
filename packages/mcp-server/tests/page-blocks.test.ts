// Block write tools answer compactly unless asked for the tree, and pass
// unknown-field rejections through with their suggestions.
import { describe, it, expect } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { pageBlockTools } from '../src/tools/page-blocks.js';

interface Recorded { method: string; url: string; body: string | null }

function setup(responder: (call: Recorded) => Response = () => json({ ok: true })) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    return responder(call);
  };
  return { deps: { client: new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb', fetchImpl }), siteId: 'mysite' }, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const tool = (name: string) => pageBlockTools.find(candidate => candidate.name === name)!;
const BASE = 'https://example.test/api/v1/sites/mysite';

describe('block write tools', () => {
  const writes: Array<[string, Record<string, unknown>, string, string]> = [
    ['add_block', { page_id: 'home', block: { type: 'core/heading' } }, 'POST', `${BASE}/pages/home/blocks`],
    ['update_block', { target: { kind: 'partial', id: 'header' }, block_id: 'b', data: { text: 'x' } }, 'PATCH', `${BASE}/containers/partial/header/blocks`],
    ['move_block', { page_id: 'home', block_id: 'b', target_parent_id: null }, 'PUT', `${BASE}/pages/home/blocks`],
    ['duplicate_block', { target: { kind: 'template', id: 'post' }, block_id: 'b' }, 'POST', `${BASE}/containers/template/post/blocks/duplicate`],
    ['set_block_responsive', { page_id: 'home', block_id: 'b', field: 'cols', value: { mobile: 1 } }, 'POST', `${BASE}/pages/home/blocks/responsive`],
  ];

  for (const [name, args, method, url] of writes) {
    it(`${name} asks for the summary by default and the tree on request`, async () => {
      const { deps, calls } = setup();
      await tool(name).handler(args as never, deps);
      await tool(name).handler({ ...args, response: 'tree', version: 'redesign' } as never, deps);
      expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
        `${method} ${url}?response=summary`,
        `${method} ${url}?version=redesign&response=tree`,
      ]);
      // The body never carries it, so an older Core that refuses unknown body keys still accepts the write.
      for (const call of calls) expect(JSON.parse(call.body!)).not.toHaveProperty('response');
    });
  }

  it('remove_block sends the block id and the response shape as query parameters', async () => {
    const { deps, calls } = setup();
    await tool('remove_block').handler({ page_id: 'home', block_id: 'b 1' } as never, deps);
    await tool('remove_block').handler({ page_id: 'home', block_id: 'b', response: 'tree', version: 'v2' } as never, deps);
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `DELETE ${BASE}/pages/home/blocks?block_id=b+1&response=summary`,
      `DELETE ${BASE}/pages/home/blocks?block_id=b&version=v2&response=tree`,
    ]);
  });

  it('returns the compact answer as the API sends it', async () => {
    const summary = { added_id: 'blk_1', block: { id: 'blk_1', type: 'core/heading', data: {} }, parent_id: 'sec', slot_index: null, position: 2, has_unsaved_changes: true };
    const { deps } = setup(() => json(summary));
    const result = await tool('add_block').handler({ page_id: 'home', block: { type: 'core/heading' }, parent_id: 'sec' } as never, deps);
    expect(JSON.parse(result.content[0]!.text)).toEqual(summary);
  });

  it('passes an unknown_field rejection through with its suggestions', async () => {
    const rejection = {
      error: 'data.placeholder_background is not a field of core/repeater; it is a field of the item block core/post_card. Did you mean item_overrides.placeholder_background?',
      code: 'unknown_field',
      unknown_fields: [{ key: 'placeholder_background', suggestions: ['item_overrides.placeholder_background'] }],
    };
    const { deps } = setup(() => json(rejection, 400));
    const result = await tool('update_block').handler({ target: { kind: 'template', id: 'content-type-articles' }, block_id: 'related-list', data: { placeholder_background: '#eee' } } as never, deps);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text) as { status: number; body: typeof rejection };
    expect(body.status).toBe(400);
    expect(body.body.unknown_fields[0]!.suggestions).toEqual(['item_overrides.placeholder_background']);
  });

  it('documents the compact answer, null removal and the unknown-field rejection', () => {
    for (const name of ['add_block', 'update_block', 'move_block', 'remove_block', 'duplicate_block', 'set_block_responsive']) {
      expect(tool(name).description).toMatch(/response: "tree"/);
      expect(tool(name).description).toContain('has_unsaved_changes');
    }
    expect(tool('update_block').description).toContain('A `null` value removes that key');
    expect(tool('update_block').description).toContain('item_overrides.<key>');
    expect(tool('add_block').description).toContain('unknown_field');
  });
});
