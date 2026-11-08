// The clipboard tools map onto /api/v1/sites/{siteId}/clipboard/*: copying
// is a read that returns the clipboard text, pasting a write that sends it
// back unchanged with the position.

import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { clipboardTools } from '../src/tools/clipboard.js';
import { effectFor } from '../src/server.js';

const CLIP = '{"typeroll_clipboard":1,"source":{"site_id":"studio"}}';
interface Recorded { method: string; url: string; body: unknown }
function setup() {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const copy = String(input).includes('/clipboard/copy');
    return new Response(JSON.stringify(copy ? { clipboard: { big: true }, clipboard_text: CLIP, clipboard_html: '<p></p>', count: { top: 1, total: 2 }, warnings: [] } : { message: 'Pasted 1 block' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb', fetchImpl }), calls };
}
const tool = (name: string) => clipboardTools.find(t => t.name === name)!;
const text = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

describe('clipboard tools', () => {
  it('copies blocks to clipboard text and pastes it on another site', async () => {
    const { client, calls } = setup();
    const copied = text(await tool('copy_blocks').handler({ page_id: 'home', block_ids: ['b1', 'b2'], version: 'redesign' } as never, { client, siteId: 'studio' }));
    // Only the text travels back to the agent, not the clipboard twice.
    expect(copied).toEqual({ clipboard: CLIP, count: { top: 1, total: 2 }, warnings: [] });
    await tool('paste_blocks').handler({ clipboard: copied.clipboard, page_id: 'home', after_block_id: 'left' } as never, { client, siteId: 'bakery' });
    await tool('paste_blocks').handler({ clipboard: copied.clipboard, page_id: 'home', position: 0, parent_id: 'cols', slot_index: 1 } as never, { client, siteId: 'bakery' });
    expect(calls).toEqual([
      { method: 'POST', url: 'https://example.test/api/v1/sites/studio/clipboard/copy?version=redesign', body: { page_id: 'home', block_ids: ['b1', 'b2'] } },
      { method: 'POST', url: 'https://example.test/api/v1/sites/bakery/clipboard/paste', body: { clipboard: CLIP, page_id: 'home', after_block_id: 'left' } },
      { method: 'POST', url: 'https://example.test/api/v1/sites/bakery/clipboard/paste', body: { clipboard: CLIP, page_id: 'home', position: 0, parent_id: 'cols', slot_index: 1 } },
    ]);
    expect(['copy_blocks', 'paste_blocks'].map(effectFor)).toEqual(['read', 'write']);
    expect(tool('paste_blocks').description).toContain('never mapped');
  });
});
