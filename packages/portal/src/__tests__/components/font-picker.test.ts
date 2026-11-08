// @vitest-environment happy-dom
// The font picker, the site's font settings and the Fonts library in a
// browser-like DOM. Stylesheet loading is recorded instead of performed, and
// every API call is a mocked fetch, so nothing reaches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SiteFontFile, SiteSettings } from '@typeroll/shared';

const loaded = vi.hoisted(() => ({ stylesheets: [] as string[], faces: [] as string[] }));
vi.mock('../../components/font-preview', async original => ({
  ...await original<typeof import('../../components/font-preview')>(),
  ensureStylesheet: (href: string | null | undefined) => { if (href && !loaded.stylesheets.includes(href)) loaded.stylesheets.push(href); },
  ensureUploadFaces: (siteId: string) => { if (!loaded.faces.includes(siteId)) loaded.faces.push(siteId); },
}));

import FontPicker from '../../components/FontPicker';
import SiteFontSettings from '../../components/SiteFontSettings';
import FontLibrary from '../../components/FontLibrary';
import { useSandboxFontHead } from '../../components/font-preview';

let root: Root | undefined;
let container: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const brand: SiteFontFile = {
  id: 'f1', family: 'Brand Serif', weight: 400, style: 'normal', category: 'serif',
  file: { format: 'woff2', bytes: 40_000, sha256: 'abc', key: 'fonts/f1.woff2' },
  original: { format: 'otf', bytes: 90_000, sha256: 'def', key: 'fonts/f1.otf' },
  licence: { confirmed: true, by: 'anna@example.com', at: '2026-11-01T10:00:00.000Z', note: 'Web licence 12' },
  created_at: '2026-11-01T10:00:00.000Z',
};

// Report every observed option as visible, as a browser does for the first screen.
class VisibleObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  unobserve() {}
  disconnect() {}
}

async function mount(element: ReturnType<typeof createElement>, wrapInForm = true) {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  const host = document.createElement(wrapInForm ? 'form' : 'div');
  container = document.createElement('div');
  host.append(container);
  document.body.append(host);
  root = createRoot(container);
  await act(async () => root!.render(element));
}
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const click = async (target: Element) => act(async () => { (target as HTMLElement).click(); });
async function type(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = async (target: Element, keyName: string) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })); });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', VisibleObserver);
  loaded.stylesheets.length = 0;
  loaded.faces.length = 0;
  request = vi.fn(async () => reply(200, { fonts: [brand], used_by: {} }));
  vi.stubGlobal('fetch', request);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('FontPicker', () => {
  const picker = (props: Record<string, unknown> = {}) => createElement(FontPicker, {
    siteId: 'site-1', role: 'heading', label: 'Heading font', name: 'fonts.heading', value: 'Inter', language: 'sv',
    fonts: { heading: 'Inter', body: 'Lora' }, uploads: [brand], ...props,
  });

  it('shows the current choice beside the site’s body font, in the site’s language', async () => {
    await mount(picker());
    expect(container.querySelector('.fp-current-name')!.textContent).toBe('Inter');
    const samples = [...container.querySelectorAll('.fp-sample')].map(sample => sample.textContent);
    expect(samples[0]).toContain('Heading · Inter');
    expect(samples[0]).toContain('Flygande bäckasiner');
    expect(samples[1]).toContain('Body · Lora');
    expect(container.querySelector<HTMLInputElement>('input[type="hidden"][name="fonts.heading"]')!.value).toBe('Inter');
    // The context loads both families with only the sample characters.
    expect(loaded.stylesheets.some(href => href.startsWith('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&text='))).toBe(true);
    expect(loaded.stylesheets.some(href => href.startsWith('https://fonts.googleapis.com/css2?family=Lora:'))).toBe(true);
  });

  it('opens a combobox with sections, searches and picks with the keyboard', async () => {
    const form = () => container.closest('form')!;
    const changes: string[] = [];
    await mount(picker());
    form().addEventListener('input', event => changes.push((event.target as HTMLInputElement).name));
    await click(button('Change heading font'));
    const search = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute('aria-controls')).toBe(container.querySelector('[role="listbox"]')!.id);
    expect([...container.querySelectorAll('.fp-section__label')].map(label => label.textContent)).toEqual(['Your fonts', 'System', 'Catalog']);
    expect(loaded.faces).toEqual(['site-1']);

    await type(search, 'playfair display');
    // Searching is not an edit of the settings form.
    expect(changes).toEqual([]);
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options[0]!.textContent).toContain('Playfair Display');
    expect(options[0]!.textContent).toContain('Serif');
    expect(loaded.stylesheets.some(href => href.includes('family=Playfair+Display'))).toBe(true);

    await key(search, 'ArrowDown');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await key(search, 'Enter');
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(container.querySelector('.fp-current-name')!.textContent).toBe('Playfair Display');
    expect(container.querySelector<HTMLInputElement>('input[name="fonts.heading"]')!.value).toBe('Playfair Display');
    expect(changes).toEqual(['fonts.heading']);
  });

  it('offers any Google Fonts family by name and closes on Escape', async () => {
    await mount(picker());
    await click(button('Change heading font'));
    const search = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await type(search, 'Rare Family');
    expect(container.textContent).toContain('Use “Rare Family” from Google Fonts');
    await key(search, 'Escape');
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(document.activeElement?.textContent).toContain('Change heading font');
  });

  it('filters with chips and explains which characters every family has', async () => {
    await mount(picker());
    await click(button('Change heading font'));
    expect(container.textContent).toContain('Every family has Swedish, Norwegian, Danish, Finnish and German letters');
    const mono = button('Monospace');
    await click(mono);
    expect(mono.getAttribute('aria-pressed')).toBe('true');
    const metas = [...container.querySelectorAll('.fp-option__meta')].map(meta => meta.textContent);
    expect(metas.length).toBeGreaterThan(3);
    expect(metas.every(meta => meta!.startsWith('Monospace'))).toBe(true);
  });

  it('offers the unset choice for display and shows the heading it falls back to', async () => {
    await mount(picker({ role: 'display', label: 'Display font', name: 'fonts.display', value: 'Anton', emptyLabel: 'Same as heading', renderVersion: 15 }));
    await click(button('Same as heading'));
    expect(container.querySelector('.fp-current-name')!.textContent).toBe('Same as heading (Inter)');
    expect(container.querySelector<HTMLInputElement>('input[name="fonts.display"]')!.value).toBe('');
  });
});

describe('SiteFontSettings', () => {
  const fonts: SiteSettings['fonts'] = { heading: 'Inter', body: 'Inter', size_base: 16 };

  it('lists the five roles and notes when display and accent take effect', async () => {
    await mount(createElement(SiteFontSettings, { siteId: 'site-1', fonts, language: 'en', renderVersion: 14 }));
    const names = [...container.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(input => input.name);
    expect(names).toEqual(['fonts.heading', 'fonts.body', 'fonts.display', 'fonts.accent', 'fonts.mono', 'fonts.services']);
    expect(container.textContent).toContain('Display and accent take effect from render version 15');
    expect(container.textContent).toContain('Adobe’s licence does not allow self-hosting');
    expect(request).toHaveBeenCalledWith('/api/sites/site-1/fonts', expect.anything());
  });

  it('reads a font service’s families, lists them and serialises the services', async () => {
    request.mockImplementation(async (url: string) => url.endsWith('/services/inspect')
      ? reply(200, { families: ['Proxima Nova'], stylesheet: '@font-face{}' })
      : reply(200, { fonts: [], used_by: {} }));
    await mount(createElement(SiteFontSettings, { siteId: 'site-1', fonts, renderVersion: 15 }));
    const field = container.querySelector<HTMLInputElement>('.site-font-services input:not([type="hidden"])')!;
    await type(field, 'abc1def');
    await act(async () => { button('Add').click(); });
    const inspect = request.mock.calls.find(call => String(call[0]).endsWith('/services/inspect'))!;
    expect(JSON.parse((inspect[1] as RequestInit).body as string)).toEqual({ provider: 'adobe', kit: 'abc1def' });
    expect(container.textContent).toContain('Adobe Fonts — web project abc1def');
    expect(container.textContent).toContain('Proxima Nova');
    const hidden = container.querySelector<HTMLInputElement>('input[name="fonts.services"]')!;
    expect(JSON.parse(hidden.value)).toEqual([{ provider: 'adobe', kit: 'abc1def', families: ['Proxima Nova'] }]);

    await click(button('Remove'));
    expect(hidden.value).toBe('');
  });

  it('explains a pasted URL that is not a font service', async () => {
    await mount(createElement(SiteFontSettings, { siteId: 'site-1', fonts, renderVersion: 15 }));
    await type(container.querySelector<HTMLInputElement>('.site-font-services input:not([type="hidden"])')!, 'https://example.com/a.css');
    await act(async () => { button('Add').click(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('fonts.bunny.net');
    expect(request.mock.calls.some(call => String(call[0]).includes('services/inspect'))).toBe(false);
  });
});

describe('FontLibrary', () => {
  it('lists families in their own font with sizes, formats and the roles using them', async () => {
    await mount(createElement(FontLibrary, { siteId: 'site-1', canEdit: true, language: 'de', initial: { fonts: [brand], used_by: { 'Brand Serif': ['heading'] } } }), false);
    expect(container.querySelector('h2#family-Brand-Serif')!.textContent).toBe('Brand Serif');
    expect(container.querySelector<HTMLElement>('.fl-preview')!.style.fontFamily).toContain('Brand Serif');
    expect(container.textContent).toContain('Zwölf Boxkämpfer');
    expect(container.textContent).toContain('Used for: Heading');
    expect(container.textContent).toContain('39 KB');
    expect(container.textContent).toContain('WOFF2, converted from OTF');
    expect(container.textContent).toContain('Web licence 12');
    expect(loaded.faces).toEqual(['site-1']);
  });

  it('explains the catalog and uploads when the library is empty', async () => {
    request.mockImplementation(async () => reply(200, { fonts: [], used_by: {} }));
    await mount(createElement(FontLibrary, { siteId: 'site-1', canEdit: false }), false);
    expect(container.textContent).toContain('No fonts uploaded yet');
    expect(container.textContent).toContain('catalog of 250 open-licence families');
    expect(container.textContent).toContain('A site admin can upload and change fonts.');
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('inspects a chosen file, prefills it and uploads it after the licence confirmation', async () => {
    const uploaded: SiteFontFile = { ...brand, id: 'f2', family: 'Brand Sans', weight: [100, 900], original: undefined };
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/fonts/inspect')) return reply(200, { info: { format: 'ttf', family: 'Brand Sans', weight: 400, italic: false, variable: { axes: ['wght'], wght: [100, 900] } } });
      if (init?.method === 'POST') return reply(201, { font: uploaded });
      return reply(200, { fonts: [], used_by: {} });
    });
    await mount(createElement(FontLibrary, { siteId: 'site-1', canEdit: true }), false);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('.woff2,.woff,.ttf,.otf');
    const file = new File([new Uint8Array(64)], 'BrandSans.ttf');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('variable font, weights 100–900');
    expect(container.querySelector<HTMLInputElement>('input[placeholder="From the file"]')!.value).toBe('Brand Sans');

    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(container.textContent).toContain('Confirm that the font’s licence allows using it on this website.');
    expect(request.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST' && String(call[0]).endsWith('/fonts'))).toHaveLength(0);

    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    const post = request.mock.calls.find(call => String(call[0]) === '/api/sites/site-1/fonts' && (call[1] as RequestInit).method === 'POST')!;
    const body = (post[1] as RequestInit).body as FormData;
    expect(body.get('weight')).toBe('100-900');
    expect(body.get('licence_confirmed')).toBe('true');
    expect(container.textContent).toContain('Uploaded Brand Sans 100–900 variable');
    expect(container.querySelector('h2#family-Brand-Sans')).not.toBeNull();
  });

  it('deletes a file after confirming and shows the warning', async () => {
    request.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? reply(200, { deleted: true, warning: 'Heading still names Brand Serif.' })
      : reply(200, { fonts: [brand], used_by: {} }));
    await mount(createElement(FontLibrary, { siteId: 'site-1', canEdit: true, initial: { fonts: [brand], used_by: { 'Brand Serif': ['heading'] } } }), false);
    await click(container.querySelector('button[aria-label="Delete Brand Serif 400 Regular"]')!);
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain('Heading uses this family.');
    await click(container.querySelector('.fl-confirm .btn--danger')!);
    expect(request).toHaveBeenCalledWith('/api/sites/site-1/fonts/f1', expect.objectContaining({ method: 'DELETE' }));
    expect(container.textContent).toContain('Deleted. Heading still names Brand Serif.');
    expect(container.textContent).toContain('No fonts uploaded yet');
  });
});

describe('fonts in a sandboxed preview', () => {
  function Head({ fonts }: { fonts: Record<string, string> }) {
    return createElement('output', null, useSandboxFontHead('site-sandbox', fonts, [brand]));
  }

  it('links Google families and embeds uploaded files as data URLs', async () => {
    request.mockImplementation(async (url: string) => url.endsWith('/fonts/f1/file')
      ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer }
      : reply(404, {}));
    await mount(createElement(Head, { fonts: { heading: 'Brand Serif', body: 'Inter' } }), false);
    const head = container.querySelector('output')!.textContent!;
    expect(head).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&amp;display=swap">');
    expect(head).toContain(`src:url("data:font/woff2;base64,${btoa('wOF2')}") format("woff2");font-weight:400;font-style:normal`);
    expect(request).toHaveBeenCalledWith('/api/sites/site-sandbox/fonts/f1/file');
  });
});
