// @vitest-environment happy-dom
// Handing a site over, in the portal UI: the block editor with the structure
// locked (no Add tab, no drag, duplicate, paste or delete; text still
// editable), the start view for editors and the Handover card for builders,
// and the handover editor's save request. Every request is a mocked fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/editor-canvas-frame', async (load) => ({ ...await load<typeof import('../../lib/editor-canvas-frame')>(), useEditorCanvasId: () => null }));
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Block, Page } from '@typeroll/shared';
import BlockPageEditor, { STRUCTURE_LOCKED_NOTE } from '../../components/BlockPageEditor';
import { HandoverCard, HandoverStartView } from '../../components/HandoverStartView';
import HandoverEditor, { checklistItemId } from '../../components/HandoverEditor';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });

let root: Root | undefined;
let request: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;

beforeEach(() => {
  request = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/blocks/list')) return reply(200, { block_types: [] });
    if (path.endsWith('/pages/home/blocks') && (!init?.method || init.method === 'GET')) return reply(200, { blocks: [] });
    if (path.endsWith('/settings') && init?.method === 'PATCH') return reply(200, { saved: true, handover: JSON.parse(String(init.body)).handover });
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

async function mount(element: ReturnType<typeof createElement>) {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  await flush();
}
const buttons = (label: string) => [...container.querySelectorAll('button')].filter(button => (button.textContent ?? '').includes(label) || button.title.startsWith(label) || button.getAttribute('aria-label')?.startsWith(label));

describe('the block editor with the structure locked', () => {
  const blocks: Block[] = [{ id: 'h1', type: 'core/heading', data: { text: 'Hello' } }, { id: 'p1', type: 'core/prose', data: { html: '<p>World</p>' } }];
  const page = { id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks } as unknown as Page;

  it('offers no structural actions and says why', async () => {
    await mount(createElement(BlockPageEditor, { siteId: 'client', page, previewUrl: 'about:blank', lastDeployedAt: null, structureLocked: true }));
    expect(container.querySelector('[data-structure-locked]')?.textContent).toBe(STRUCTURE_LOCKED_NOTE);
    expect(buttons('Add').filter(button => button.textContent?.trim() === 'Add')).toHaveLength(0);
    expect(container.querySelectorAll('.block-editor__tree-row')).toHaveLength(2);
    for (const label of ['Duplicate', 'Delete', 'Paste after', 'Drag to move']) expect(container.querySelector(`[title^="${label}"], [aria-label^="${label}"]`), label).toBeNull();
    // Copy stays: copying changes nothing.
    expect(container.querySelector('[aria-label^="Copy Hello"]')).not.toBeNull();
    // Delete key on a selected block sends nothing.
    await act(async () => { (container.querySelector('.block-editor__tree-row') as HTMLElement).click(); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
    await flush();
    expect(request.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
  });

  it('keeps the Add tab and the tree actions when unlocked', async () => {
    await mount(createElement(BlockPageEditor, { siteId: 'client', page, previewUrl: 'about:blank', lastDeployedAt: null }));
    expect(container.querySelector('[data-structure-locked]')).toBeNull();
    expect(buttons('Add').some(button => button.textContent?.trim() === 'Add')).toBe(true);
    expect(container.querySelectorAll('[title="Delete"]')).toHaveLength(2);
  });
});

describe('the site overview after a handover', () => {
  const handover = { lock_structure: true, start_page: 'home', checklist: [{ id: 'photos', label: 'Replace the sample photos', href: '/app/sites/client/media' }, { id: 'domain', label: 'Connect the domain', done: true }] };

  it('shows editors the start page, the checklist read-only and their pages', () => {
    const html = renderToStaticMarkup(createElement(HandoverStartView, {
      siteId: 'client', siteName: 'Bistro', handover, locked: true,
      startPage: { id: 'home', title: 'Home', path: '/' }, pages: [{ id: 'menu', title: 'Menu', path: '/menu' }],
    }));
    document.body.innerHTML = html;
    expect(document.querySelector('[data-handover-start-page]')?.getAttribute('href')).toBe('/app/sites/client/pages/home');
    expect(document.body.textContent).toContain('1 of 2 done');
    expect(document.body.textContent).toContain(STRUCTURE_LOCKED_NOTE);
    expect(document.querySelector('[data-checklist-item="photos"] a')?.getAttribute('href')).toBe('/app/sites/client/media');
    expect(document.querySelectorAll('[data-handover-start] input, [data-handover-start] button')).toHaveLength(0);
    expect(document.querySelector('a[href="/app/sites/client/pages/menu"]')?.textContent).toBe('Menu');
  });

  it('shows builders a card with the progress and a link to edit it', () => {
    document.body.innerHTML = renderToStaticMarkup(createElement(HandoverCard, { siteId: 'client', handover: { ...handover, handed_over_at: '2026-11-07T12:00:00Z' } }));
    expect(document.body.textContent).toContain('1 of 2 done');
    expect(document.body.textContent).toContain('structure locked for editors');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/app/sites/client/settings/handover');
  });
});

describe('the handover editor', () => {
  it('saves the whole object, including a new item, the lock and the start page', async () => {
    await mount(createElement(HandoverEditor, { siteId: 'client', initial: { checklist: [{ id: 'domain', label: 'Connect the domain' }] }, pages: [{ id: 'home', title: 'Home', path: '/' }] }));
    const input = container.querySelector('input[aria-label="New checklist item"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Replace the sample photos');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => { select.value = 'home'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { buttons('Save handover')[0].click(); });
    await flush();
    const patch = request.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(String(patch[0])).toBe('/api/sites/client/settings');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ handover: {
      lock_structure: true, start_page: 'home',
      checklist: [{ id: 'domain', label: 'Connect the domain' }, { id: 'replace-the-sample-photos', label: 'Replace the sample photos' }],
    } });
    expect(container.textContent).toContain('Handover saved.');
  });

  it('stamps handed_over_at and gives items unique ids', async () => {
    await mount(createElement(HandoverEditor, { siteId: 'client', initial: null, pages: [] }));
    await act(async () => { buttons('Mark as handed over')[0].click(); });
    await flush();
    const body = JSON.parse(String((request.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')![1] as RequestInit).body));
    expect(Number.isNaN(Date.parse(body.handover.handed_over_at))).toBe(false);
    expect(checklistItemId('Connect the domain', ['connect-the-domain'])).toBe('connect-the-domain-2');
    expect(checklistItemId('Byt bilderna på förstasidan', [])).toBe('byt-bilderna-pa-forstasidan');
  });
});
