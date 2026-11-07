// @vitest-environment happy-dom
// Copy and paste in the block editor: Cmd/Ctrl+C copies the selected block
// through the copy route and writes the JSON to the clipboard, Cmd/Ctrl+V
// (the paste event) pastes it after the selected block and reloads the
// draft, keys in text fields keep their meaning, other clipboard text is
// ignored, and the tree rows offer Copy and Paste. Every request is a mocked
// fetch and the clipboard is a fake, so nothing reaches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No canvas frame: happy-dom does not load frames, and the canvas is not what is tested here.
vi.mock('../../lib/editor-canvas-frame', async (load) => ({ ...await load<typeof import('../../lib/editor-canvas-frame')>(), useEditorCanvasId: () => null }));
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Block, Page } from '@typeroll/shared';
import BlockPageEditor from '../../components/BlockPageEditor';
import { copiedLine, copyBlocksToClipboard, installClipboardShortcuts, pastedLine } from '../../components/block-clipboard';

const CLIP = JSON.stringify({ typeroll_clipboard: 1, source: { site_id: 'studio' } });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });

let root: Root | undefined;
let request: ReturnType<typeof vi.fn>;
let written: string[];
let blocks: Block[];

function key(target: EventTarget, keyName: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: keyName, metaKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
function paste(target: EventTarget, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
  target.dispatchEvent(event);
  return event;
}
const calls = (suffix: string) => request.mock.calls.filter(call => String(call[0]).endsWith(suffix));

beforeEach(() => {
  written = [];
  blocks = [
    { id: 'h1', type: 'core/heading', data: { text: 'Hello' } },
    { id: 'p1', type: 'core/prose', data: { html: '<p>World</p>' } },
  ];
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (text: string) => { written.push(text); }), readText: vi.fn(async () => CLIP) } });
  request = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/clipboard/copy')) return reply(200, { clipboard_text: CLIP, clipboard_html: '<p>Hello</p>', count: { top: 1, total: 1 }, warnings: [] });
    if (path.endsWith('/clipboard/paste')) {
      blocks = [...blocks.slice(0, 1), { id: 'new1', type: 'core/heading', data: { text: 'Hello' } }, ...blocks.slice(1)];
      return reply(200, { page: { id: 'home', added_ids: ['new1'], blocks }, mode: 'other_site', media: { copied: 0, reused: 0, left_out: 0, kept_external: 0 }, message: 'Pasted 1 block; created the style Hero (imported)', report: { warnings: [] } });
    }
    if (path.endsWith('/pages/home/blocks') && (!init?.method || init.method === 'GET')) return reply(200, { blocks });
    if (path.includes('/pages/home/blocks') && init?.method === 'DELETE') { blocks = blocks.filter(block => !path.includes(block.id)); return reply(200, { blocks }); }
    if (path.endsWith('/blocks/list')) return reply(200, { block_types: [] });
    return reply(404, { error: 'Not found' });
  });
  vi.stubGlobal('fetch', request);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountEditor() {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const page = { id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks } as unknown as Page;
  await act(async () => root!.render(createElement(BlockPageEditor, { siteId: 'bakery', page, previewUrl: 'about:blank', lastDeployedAt: null })));
  await flush();
  return container;
}
const row = (container: HTMLElement, label: string) => [...container.querySelectorAll('.block-editor__tree-row')].find(item => item.textContent?.includes(label)) as HTMLElement;

describe('block clipboard in the editor', () => {
  it('copies the selected block with Cmd/Ctrl+C and pastes it after the selection with Cmd/Ctrl+V', async () => {
    const container = await mountEditor();
    // Nothing selected: Cmd+C is the browser's.
    expect(key(document.body, 'c').defaultPrevented).toBe(false);
    await act(async () => row(container, 'Hello').click());
    const copy = key(document.body, 'c');
    expect(copy.defaultPrevented).toBe(true);
    await flush();
    expect(JSON.parse(String(calls('/api/sites/bakery/clipboard/copy')[0]![1]!.body))).toEqual({ page_id: 'home', block_ids: ['h1'] });
    expect(written).toEqual([CLIP]);
    expect(container.textContent).toContain('Copied 1 block');

    const pasted = paste(document.body, CLIP);
    expect(pasted.defaultPrevented).toBe(true);
    await flush();
    const body = JSON.parse(String(calls('/api/sites/bakery/clipboard/paste')[0]![1]!.body));
    expect(body).toEqual({ clipboard: CLIP, page_id: 'home', after_block_id: 'h1' });
    expect(container.textContent).toContain('Pasted 1 block; created the style Hero (imported)');
    // The draft was reloaded and the pasted block is in the tree.
    expect([...container.querySelectorAll('.block-editor__tree-row')].length).toBe(3);
  });

  it('leaves text fields and other clipboard content alone', async () => {
    const container = await mountEditor();
    await act(async () => row(container, 'Hello').click());
    const input = document.createElement('input');
    document.body.append(input);
    expect(key(input, 'c').defaultPrevented).toBe(false);
    expect(paste(input, CLIP).defaultPrevented).toBe(false);
    expect(paste(document.body, 'just some text').defaultPrevented).toBe(false);
    await flush();
    expect(calls('/clipboard/copy')).toHaveLength(0);
    expect(calls('/clipboard/paste')).toHaveLength(0);
  });

  it('cuts with Cmd/Ctrl+X, and offers Copy and Paste on each tree row', async () => {
    const container = await mountEditor();
    await act(async () => row(container, 'World').click());
    key(document.body, 'x', { ctrlKey: true, metaKey: false });
    await flush();
    expect(calls('/clipboard/copy')).toHaveLength(1);
    expect(request.mock.calls.some(call => (call[1] as RequestInit | undefined)?.method === 'DELETE' && String(call[0]).includes('block_id=p1'))).toBe(true);
    expect(container.textContent).toContain('Cut 1 block');

    const pasteButton = container.querySelector('button[aria-label="Paste after Hello"]') as HTMLButtonElement;
    await act(async () => pasteButton.click());
    await flush();
    expect(JSON.parse(String(calls('/clipboard/paste')[0]![1]!.body)).after_block_id).toBe('h1');
    const copyButton = container.querySelector('button[aria-label="Copy Hello"]') as HTMLButtonElement;
    await act(async () => copyButton.click());
    await flush();
    expect(JSON.parse(String(calls('/clipboard/copy')[1]![1]!.body)).block_ids).toEqual(['h1']);
  });
});

describe('block clipboard helpers', () => {
  it('falls back to reading the clipboard when the browser fires no paste event', async () => {
    vi.useFakeTimers();
    const pasteText = vi.fn();
    const remove = installClipboardShortcuts(window, { canCopy: () => false, copy: vi.fn(), paste: pasteText, readText: async () => CLIP }, { fallbackMs: 50 });
    key(document.body, 'v');
    await vi.advanceTimersByTimeAsync(60);
    expect(pasteText).toHaveBeenCalledWith(CLIP);
    // A paste event cancels the fallback, so a paste never runs twice.
    pasteText.mockClear();
    key(document.body, 'v');
    paste(document.body, CLIP);
    await vi.advanceTimersByTimeAsync(60);
    expect(pasteText).toHaveBeenCalledTimes(1);
    remove();
    vi.useRealTimers();
  });

  it('writes the JSON and a readable HTML flavour where the browser takes several', async () => {
    const items: Array<Record<string, Promise<Blob>>> = [];
    class FakeItem { constructor(readonly parts: Record<string, Promise<Blob>>) { items.push(parts); } }
    vi.stubGlobal('ClipboardItem', FakeItem);
    const write = vi.fn(async () => {});
    const result = await copyBlocksToClipboard('bakery', 'home', ['h1'], { write, writeText: vi.fn() } as unknown as Clipboard);
    expect(result.count.top).toBe(1);
    expect(await (await items[0]!['text/plain']!).text()).toBe(CLIP);
    expect(await (await items[0]!['text/html']!).text()).toBe('<p>Hello</p>');
    expect(copiedLine(2)).toBe('Copied 2 blocks');
    expect(pastedLine({ message: 'Pasted 1 block', report: { warnings: ['One image was left out.', 'Another'] } })).toBe('Pasted 1 block. One image was left out. (+1 more)');
  });
});
