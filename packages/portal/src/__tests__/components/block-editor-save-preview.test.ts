// @vitest-environment happy-dom
// Save in the block editor renders the saved page in the canvas. Saving
// first flushes pending edits to the working copy, which reloads the canvas
// while the commit is still running; that render can read the page before the
// commit and the working copy after it. Save therefore reloads the canvas once
// more after the commit (a fresh frame, busy until it reports ready). Every
// request is a mocked fetch; happy-dom does not load the frame.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Page } from '@typeroll/shared';
import BlockPageEditor from '../../components/BlockPageEditor';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });

let root: Root | undefined;
let releaseCommit: (() => void) | null;
let commitStarted: Promise<void>;
let markCommitStarted: () => void;

beforeEach(() => {
  releaseCommit = null;
  commitStarted = new Promise(resolve => { markCommitStarted = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/working-copy/') && init?.method === 'PUT') return reply(200, { ok: true });
    if (path.includes('/working-copy/') && init?.method === 'POST') {
      markCommitStarted();
      await new Promise<void>(resolve => { releaseCommit = resolve; });
      return reply(200, { ok: true });
    }
    if (path.endsWith('/blocks/list')) return reply(200, { block_types: [] });
    return reply(404, { error: 'Not found' });
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const canvas = () => document.querySelector('iframe[title="Preview"]') as HTMLIFrameElement | null;
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as HTMLButtonElement;

describe('Save in the block editor', () => {
  it('reloads the canvas after the commit, so it shows the saved page', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const page = { id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks: [{ id: 'h1', type: 'core/heading', data: { text: 'Hello' } }] } as unknown as Page;
    await act(async () => root!.render(createElement(BlockPageEditor, { siteId: 'bakery', page, previewUrl: 'about:blank', lastDeployedAt: null })));
    await flush();
    expect(canvas()).not.toBeNull();

    // An unsaved title edit: Save flushes it to the working copy first.
    const title = document.getElementById('block-page-title') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Renamed');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Publish').click());
    await act(async () => button('Save').click());
    await act(async () => { await commitStarted; });
    // The flush reloaded the canvas while the commit is running.
    const duringCommit = canvas();
    expect(duringCommit).not.toBeNull();

    await act(async () => releaseCommit!());
    await flush();
    expect(document.body.textContent).toContain('All changes saved');
    const afterSave = canvas();
    expect(afterSave).not.toBeNull();
    expect(afterSave).not.toBe(duringCommit);
    expect(afterSave!.getAttribute('aria-busy')).toBe('true');
  });
});
