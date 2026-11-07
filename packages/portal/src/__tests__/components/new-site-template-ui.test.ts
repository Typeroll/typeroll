// @vitest-environment happy-dom
// The new-site form's "Start from a template or another site": choosing
// another site, a collection package or a .typeroll file, the preview
// (publisher, licence, signature, what is not copied), the font licence and
// the create request. Every API call is a mocked fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import NewSiteFromTemplate from '../../components/NewSiteFromTemplate';
import { createBlockers, startOptions, type StartPreview } from '../../components/new-site-template-model';

let root: Root | undefined;
let container: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sitePreview = (extra: Partial<StartPreview> = {}): StartPreview => ({
  source: { name: 'Client A', site_id: 'client-a' }, counts: { pages: 3, global_blocks: 2, menus: 1, media: 4, demo_media: 0, fonts: 0 },
  package: null, signature: { status: 'unsigned' }, language: 'nl', needs: { font_licence: false, fonts: [] },
  warnings: ['The source site uses the app booking-app: install booking-app on the new site; apps, their settings and credentials are not copied.'], errors: [], ...extra,
});
const packagePreview = (extra: Partial<StartPreview> = {}): StartPreview => ({
  source: { name: 'Bakery site', version: '2.0.0', package_id: 'bakery-site' }, counts: { pages: 5, global_blocks: 2, menus: 2, media: 6, demo_media: 4, fonts: 1 },
  package: { id: 'bakery-site', name: 'Bakery site', version: '2.0.0', kind: 'site', author: { name: 'Acme Studio' }, licence: { name: 'Acme Commercial' }, languages: ['sv'] },
  signature: { status: 'unsigned' }, language: 'sv', needs: { font_licence: true, fonts: ['Brand Sans'] }, warnings: [], errors: [], ...extra,
});

async function mount(props: Parameters<typeof NewSiteFromTemplate>[0]) {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(NewSiteFromTemplate, props)));
}
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text)) as HTMLButtonElement;
const radio = (text: string) => [...container.querySelectorAll('label')].find(label => label.textContent?.includes(text))!.querySelector('input') as HTMLInputElement;
const click = async (target: Element) => act(async () => { (target as HTMLElement).click(); });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function type(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(target: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function chooseFile(name = 'bakery-site-2.0.0.typeroll') {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(4096)], name)], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
}
const calls = (suffix: string) => request.mock.calls.filter(call => String(call[0]).endsWith(suffix));
const jsonBody = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const formBody = (call: unknown[]) => (call[1] as RequestInit).body as FormData;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request = vi.fn(async () => reply(404, { error: 'Not found' }));
  vi.stubGlobal('fetch', request);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewSiteFromTemplate', () => {
  it('copies another site: previews it, lists what is not copied, creates it and shows the notes', async () => {
    request.mockImplementation(async (url: string) => String(url).endsWith('/preview')
      ? reply(200, sitePreview())
      : reply(201, { id: 'client-b', url: '/app/sites/client-b', started_from: { warnings: ['The source site uses the app booking-app: install booking-app on the new site.'], defaults: [] } }));
    const navigate = vi.fn();
    await mount({ sites: [{ id: 'client-a', name: 'Client A' }], navigate });
    // Without collection access there is no collection choice.
    expect(container.textContent).not.toContain('A site package from the collection');
    expect(button('Create site from this').disabled).toBe(true);

    await type(container.querySelector<HTMLInputElement>('input[id$="-name"]')!, 'Client B');
    await select(container.querySelector<HTMLSelectElement>('select')!, 'client-a');
    expect(calls('/api/sites/create/preview')).toHaveLength(1);
    expect(jsonBody(calls('/preview')[0])).toEqual({ from: { site_id: 'client-a' }, options: { design: 'full' } });
    const text = container.textContent!;
    expect(text).toContain('3 pages, 2 global blocks, 1 menu, 4 media files');
    expect(text).toContain('install booking-app');
    expect(text).toContain('nl');
    // A site copy has no signature to show.
    expect(container.querySelector('[aria-label="Signature"]')).toBeNull();

    await click(button('Create site from this'));
    await settle();
    expect(jsonBody(calls('/api/sites/create')[0])).toEqual({ name: 'Client B', from: { site_id: 'client-a' }, options: { design: 'full' } });
    // With notes, the person reads them and opens the site.
    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Your new site is ready');
    expect(container.querySelector<HTMLAnchorElement>('a.btn')!.getAttribute('href')).toBe('/app/sites/client-b');
  });

  it('starts from a .typeroll file: publisher, licence, signature, the font licence and demo images', async () => {
    request.mockImplementation(async (url: string) => String(url).endsWith('/preview') ? reply(200, packagePreview()) : reply(201, { id: 'bakery', url: '/app/sites/bakery', started_from: { warnings: [], defaults: [] } }));
    const navigate = vi.fn();
    await mount({ sites: [], packages: [], navigate });
    // No other sites: the file is the starting choice; the collection says it has no site packages.
    expect(radio('A .typeroll file').checked).toBe(true);
    await click(radio('A site package from the collection'));
    expect(container.textContent).toContain('no whole-site packages yet');
    await click(radio('A .typeroll file'));
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toContain('.typeroll');
    await type(container.querySelector<HTMLInputElement>('input[id$="-name"]')!, 'Bakery');
    await chooseFile();

    const preview = formBody(calls('/api/sites/create/preview')[0]);
    expect(preview.get('package')).toBeInstanceOf(File);
    expect(JSON.parse(String(preview.get('options')))).toEqual({ design: 'full' });
    const text = container.textContent!;
    expect(text).toContain('Acme Studio (not verified)');
    expect(text).toContain('Acme Commercial');
    expect(text).toContain('Unsigned');
    expect(text).toContain('4 demo images to replace');

    // The font files come only with the licence confirmed; otherwise the site starts without them.
    const licence = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('Brand Sans'))!.querySelector('input')!;
    expect(licence.checked).toBe(false);
    await click(licence);
    await click(button('Create site from this'));
    await settle();
    const created = formBody(calls('/api/sites/create')[0]);
    expect(created.get('name')).toBe('Bakery');
    expect(created.get('package')).toBeInstanceOf(File);
    expect(JSON.parse(String(created.get('options')))).toEqual({ design: 'full', font_licence_confirmed: true });
    // No warnings: straight to the new site's overview.
    expect(navigate).toHaveBeenCalledWith('/app/sites/bakery');
  });

  it('chooses a package of the collection and refuses one with an invalid signature', async () => {
    request.mockImplementation(async () => reply(200, packagePreview({ signature: { status: 'invalid' }, errors: ['The package signature does not match its contents.'] })));
    await mount({ sites: [{ id: 'client-a', name: 'Client A' }], packages: [{ id: 'bakery-1a2b', name: 'Bakery site', publisher: 'Typeroll', verified: true, pages: 5 }] });
    await click(radio('A site package from the collection'));
    const entry = container.querySelector<HTMLSelectElement>('select')!;
    expect(entry.textContent).toContain('Bakery site — Typeroll (verified) · 5 pages');
    await type(container.querySelector<HTMLInputElement>('input[id$="-name"]')!, 'Bakery');
    await select(entry, 'bakery-1a2b');
    expect(jsonBody(calls('/preview')[0])).toEqual({ from: { collection_entry: 'bakery-1a2b' }, options: { design: 'full' } });
    expect(container.querySelector('[role="alert"][aria-label="Signature"]')!.textContent).toContain('cannot start from it');
    expect(button('Create site from this').disabled).toBe(true);
  });

  it('shows a refusal from the API', async () => {
    request.mockImplementation(async (url: string) => String(url).endsWith('/preview') ? reply(200, sitePreview({ warnings: [] }))
      : reply(422, { error: 'The new site could not be created from the site "Client A". The half-created site was removed again.', code: 'site_create_failed' }));
    await mount({ sites: [{ id: 'client-a', name: 'Client A' }], navigate: vi.fn() });
    await type(container.querySelector<HTMLInputElement>('input[id$="-name"]')!, 'Client B');
    await select(container.querySelector<HTMLSelectElement>('select')!, 'client-a');
    await click(radio('Content only'));
    await settle();
    expect(jsonBody(calls('/preview').at(-1)!)).toMatchObject({ options: { design: 'content' } });
    await click(button('Create site from this'));
    await settle();
    expect(container.querySelector('.ns-error')!.textContent).toContain('removed again');
  });

  it('model: options and blockers', () => {
    expect(startOptions({ design: 'full', needsFontLicence: true, fontLicenceConfirmed: false })).toEqual({ design: 'full', fonts: false });
    expect(startOptions({ design: 'styles', needsFontLicence: true, fontLicenceConfirmed: false })).toEqual({ design: 'styles' });
    expect(createBlockers({ name: '', choice: { kind: 'site' }, preview: null })).toEqual(['Give the new site a name.', 'Choose the site to start from.']);
    expect(createBlockers({ name: 'X', choice: { kind: 'site', siteId: 'a' }, preview: sitePreview() })).toEqual([]);
  });
});
