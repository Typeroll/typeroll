// @vitest-environment happy-dom
// Customer HTML in editor previews runs in opaque-origin frames, and the
// editors trust canvas messages only from their own sandboxed frame with this
// mount's random canvas id (security findings H1 and the canvas bridge).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import type { Page, Partial as PartialDoc } from '@typeroll/shared';
import PartialEditor, { partialPreviewDocument } from '../../components/PartialEditor';
import HtmlPageEditor from '../../components/HtmlPageEditor';
import ReviewChanges from '../../components/ReviewChanges';
import {
  EDITOR_CANVAS_FRAME_SANDBOX, createEditorCanvasId, isEditorCanvasMessage,
} from '../../lib/editor-canvas-frame';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ has_working_copy: false, meta_changed: [], block_changes: [] }))));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const XSS = '<p>Hello</p><img src=x onerror="window.__pwned=1">';
const htmlPage = { id: 'page', title: 'Test', slug: 'test', status: 'published', content_mode: 'html', html_content: '' } as Page;

describe('partial preview', () => {
  it('renders draft HTML in an empty-sandbox frame, never in the portal document', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const partial = { id: 'header', name: 'Header', kind: 'header', status: 'draft', html_content: XSS } as PartialDoc;
    await act(async () => root.render(createElement(PartialEditor, { siteId: 'site', partial, lastDeployedAt: null })));
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Preview')!.click(); });
    const frame = container.querySelector('iframe[title="Partial preview"]');
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toBe(partialPreviewDocument(XSS));
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('editor canvas frames', () => {
  it('are not server-rendered with a predictable canvas id', () => {
    const html = renderToString(createElement(HtmlPageEditor, { siteId: 'site', page: htmlPage, previewUrl: '/api/sites/site/preview/page', lastDeployedAt: null }));
    expect(html).not.toContain('canvas=');
  });

  it('are sandboxed and carry a random per-mount canvas id', async () => {
    await act(async () => root.render(createElement(HtmlPageEditor, { siteId: 'site', page: htmlPage, previewUrl: '/api/sites/site/preview/page', lastDeployedAt: null })));
    const frame = container.querySelector('iframe[title="Page preview"]')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
    const canvas = new URL(frame.getAttribute('src')!, 'https://cms.example.test').searchParams.get('canvas')!;
    expect(canvas).toMatch(/^html-[0-9a-f]{32}$/);
    expect(canvas).not.toContain('site');

    await act(async () => root.render(createElement(ReviewChanges, { siteId: 'site', pageId: 'page', previewUrl: '/api/sites/site/preview/browse/test', onClose: () => {} })));
    const review = [...container.querySelectorAll('iframe')];
    expect(review).toHaveLength(2);
    for (const pane of review) expect(pane.getAttribute('sandbox')).toBe(EDITOR_CANVAS_FRAME_SANDBOX);
    const ids = review.map((pane) => new URL(pane.getAttribute('src')!, 'https://cms.example.test').searchParams.get('canvas'));
    expect(new Set(ids).size).toBe(2);
  });
});

describe('isEditorCanvasMessage', () => {
  const frameWindow = {} as Window;
  const frame = { contentWindow: frameWindow } as HTMLIFrameElement;
  const id = createEditorCanvasId('canvas');
  const message = (over: Partial<{ source: unknown; origin: string; data: unknown }> = {}) => ({
    source: frameWindow, origin: 'null',
    data: { channel: 'typeroll.editor-canvas', version: 1, canvas_id: id, type: 'ready' },
    ...over,
  }) as unknown as MessageEvent;

  it('accepts only the sandboxed frame with this canvas id', () => {
    expect(isEditorCanvasMessage(message(), frame, id)).toBe(true);
    expect(isEditorCanvasMessage(message({ origin: 'https://evil.example' }), frame, id)).toBe(false);
    expect(isEditorCanvasMessage(message({ origin: 'https://cms.example.test' }), frame, id)).toBe(false);
    expect(isEditorCanvasMessage(message({ source: {} }), frame, id)).toBe(false);
    expect(isEditorCanvasMessage(message({ data: { channel: 'typeroll.editor-canvas', version: 1, canvas_id: 'canvas-other', type: 'ready' } }), frame, id)).toBe(false);
    expect(isEditorCanvasMessage(message(), frame, null)).toBe(false);
  });

  it('creates unguessable ids the preview routes accept', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createEditorCanvasId('review-saved')));
    expect(ids.size).toBe(50);
    for (const value of ids) expect(value).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(EDITOR_CANVAS_FRAME_SANDBOX).not.toContain('allow-same-origin');
  });
});
