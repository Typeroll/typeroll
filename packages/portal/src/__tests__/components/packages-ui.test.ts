// @vitest-environment happy-dom
// The Packages page components (import and export), the block template list
// and the media library's demo badge. Every API call is a mocked fetch, so
// nothing reaches the network. The helpers are covered in
// package-models.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { BlockTemplate, Media } from '@typeroll/shared';
import PackageImport from '../../components/PackageImport';
import PackageExport from '../../components/PackageExport';
import BlockTemplateList from '../../components/BlockTemplateList';
import MediaLibrary from '../../components/MediaLibrary';
import { exportable, inspected } from './package-fixtures';

let root: Root | undefined;
let container: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function mount(element: ReturnType<typeof createElement>) {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text));
const click = async (target: Element) => act(async () => { (target as HTMLElement).click(); });
const labelled = (text: string) => {
  const label = [...container.querySelectorAll('label')].find(item => item.textContent?.trim().startsWith(text))!;
  return (label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input')) as HTMLInputElement;
};
async function type(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function chooseFile(name = 'acme-sections.typeroll', size = 2048) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(size)], name)], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
const calls = (suffix: string) => request.mock.calls.filter(call => String(call[0]).endsWith(suffix));
const optionsOf = (call: unknown[]) => JSON.parse(String(((call[1] as RequestInit).body as FormData).get('options')));

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

describe('PackageImport', () => {
  it('inspects a chosen file and shows the publisher, signature, licence, contents and the plan', async () => {
    request.mockImplementation(async () => reply(200, inspected()));
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: true }));
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toContain('.typeroll');
    await chooseFile();

    expect(calls('/api/sites/site-1/packages/inspect')).toHaveLength(1);
    expect(optionsOf(calls('/inspect')[0])).toEqual({ design: 'content' });
    const text = container.textContent!;
    expect(text).toContain('Acme Sections');
    expect(text).toContain('1.2.0');
    expect(text).toContain('Templates and parts');
    expect(text).toContain('Unsigned');
    expect(text).toContain('Acme Studio (not verified)');
    expect(text).toContain('Acme Commercial');
    expect(text).toContain('en, sv');
    expect(text).toContain('2 block templates, 1 page template');
    expect(text).toContain('Rename → hero-2');
    expect(text).toContain('Hero (imported)');
    expect(text).toContain('Reuse existing');
    expect(text).toContain('Demo');
  });

  it('re-inspects when the design mode changes, and offers fonts only with the whole look', async () => {
    request.mockImplementation(async () => reply(200, inspected()));
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: true }));
    await chooseFile();
    expect(container.textContent).not.toContain('Include fonts');
    await click(labelled('Whole look'));
    expect(calls('/inspect')).toHaveLength(2);
    expect(optionsOf(calls('/inspect')[1])).toEqual({ design: 'full', fonts: true });
    await click(labelled('Include fonts'));
    expect(optionsOf(calls('/inspect')[2])).toEqual({ design: 'full', fonts: false });
  });

  it('disables the whole look for a non-admin, with the reason', async () => {
    request.mockImplementation(async () => reply(200, inspected()));
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: false }));
    await chooseFile();
    expect(labelled('Whole look').disabled).toBe(true);
    expect(container.textContent).toContain('Only a site admin can import the whole look');
  });

  it('blocks an invalid signature', async () => {
    request.mockImplementation(async () => reply(200, inspected({ signature: { status: 'invalid' } })));
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: true }));
    await chooseFile();
    expect(container.textContent).toContain('Invalid signature');
    expect(button('Import Acme Sections')!.disabled).toBe(true);
  });

  it('needs the font licence confirmation before importing font files', async () => {
    request.mockImplementation(async () => reply(200, inspected({ needs: { admin: false, font_licence: true } })));
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: true }));
    await chooseFile();
    expect(button('Import Acme Sections')!.disabled).toBe(true);
    await click(labelled('The package’s licence lets me use'));
    expect(button('Import Acme Sections')!.disabled).toBe(false);
  });

  it('shows API errors inline with their details', async () => {
    request.mockImplementation(async () => reply(422, { error: 'The package is not valid', code: 'invalid_package', details: ['style hero: invalid id'] }));
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: true }));
    await chooseFile();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('The package is not valid');
    expect(alert.textContent).toContain('style hero: invalid id');
  });

  it('refuses a file that is not a package without calling the API', async () => {
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: true }));
    await chooseFile('photo.jpg');
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain('ending in .typeroll');
  });

  it('imports a chosen selection and links the report', async () => {
    request.mockImplementation(async (url: string) => String(url).endsWith('/import')
      ? reply(200, { report: { created: { block_templates: ['hero'], styles: ['card'] }, reused: { styles: ['lead'] }, renamed: {}, warnings: ['Check the colours.'] } })
      : reply(200, inspected()));
    await mount(createElement(PackageImport, { siteId: 'site-1', canEdit: true, isAdmin: true }));
    await chooseFile();
    await click(button('Choose entries')!);
    await click(labelled('Pricing'));
    // The plan must follow the selection before importing.
    expect(button('Import Acme Sections')!.disabled).toBe(true);
    await click(button('Update the plan for this choice')!);
    expect(optionsOf(calls('/inspect').at(-1)!).only).toEqual(['block_templates.hero', 'page_templates.landing', 'global_blocks.cta', 'site_fields.contact']);
    await click(button('Import Acme Sections')!);

    const imported = calls('/api/sites/site-1/packages/import');
    expect(imported).toHaveLength(1);
    expect(optionsOf(imported[0])).toEqual({ design: 'content', only: ['block_templates.hero', 'page_templates.landing', 'global_blocks.cta', 'site_fields.contact'] });
    expect(container.textContent).toContain('Imported Acme Sections 1.2.0.');
    const links = [...container.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')]);
    expect(links).toContainEqual(['Block templates', '/app/sites/site-1/partials#block-templates']);
    expect(links).toContainEqual(['Styles', '/app/sites/site-1/styles']);
    expect(links).toContainEqual(['media library', '/app/sites/site-1/media']);
    expect(container.textContent).toContain('1 created, 1 reused');
    expect(container.textContent).toContain('Check the colours.');
  });

  it('says importing needs write access', () => {
    const html = renderToString(createElement(PackageImport, { siteId: 'site-1', canEdit: false, isAdmin: false }));
    expect(html).toContain('Importing a package needs write access');
    expect(html).not.toContain('type="file"');
  });
});

describe('PackageExport', () => {
  it('loads what the site can export and lists it by kind and category', async () => {
    request.mockImplementation(async () => reply(200, exportable));
    await mount(createElement(PackageExport, { siteId: 'site-1', canEdit: true, isAdmin: false, language: 'sv' }));
    expect(calls('/api/sites/site-1/packages/exportable')).toHaveLength(1);
    const text = container.textContent!;
    expect(text).toContain('Heroes');
    expect(text).toContain('Section');
    expect(text).toContain('Call to action');
    expect(text).toContain('Price row');
    expect(labelled('Whole site').disabled).toBe(true);
    expect(text).toContain('Only a site admin can export the whole site.');
    expect(labelled('hero.jpg').checked).toBe(true);
    expect(labelled('logo.svg').checked).toBe(false);
    expect(labelled('Language of the sample text').value).toBe('sv');
  });

  it('lists fonts by source with the licence confirmation for uploaded files', async () => {
    await mount(createElement(PackageExport, { siteId: 'site-1', canEdit: true, isAdmin: true, initial: exportable }));
    expect(container.textContent).not.toContain('Brand Serif');
    await click(labelled('Include the design tokens'));
    expect(container.textContent).toContain('Included by name: Inter');
    expect(container.textContent).toContain('Not transferable: Proxima Nova');
    expect(container.textContent).not.toContain('The licence allows passing these font files on.');
    await click(labelled('Brand Serif'));
    expect(container.textContent).toContain('The licence allows passing these font files on.');
  });

  it('downloads the package with the name the server gives', async () => {
    const saved: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ href: this.href, download: this.download }); });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:package'), revokeObjectURL: vi.fn() }));
    request.mockImplementation(async () => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { 'Content-Type': 'application/vnd.typeroll.package+zip', 'Content-Disposition': 'attachment; filename="acme-sections-1.0.0.typeroll"' } }));
    await mount(createElement(PackageExport, { siteId: 'site-1', canEdit: true, isAdmin: true, initial: exportable }));

    await click(button('Export package')!);
    expect(container.textContent).toContain('Give the package a name.');
    expect(container.textContent).toContain('Choose at least one entry to export.');
    expect(request).not.toHaveBeenCalled();

    await click(labelled('Hero'));
    await type(labelled('Name'), 'Acme Sections');
    expect(labelled('Id').value).toBe('acme-sections');
    await click(button('Export package')!);

    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sites/site-1/packages/export');
    expect(JSON.parse(String(init.body))).toEqual({
      selection: { kind: 'collection', block_templates: ['hero'], styles: 'used', demo_media: ['m1'] },
      meta: { id: 'acme-sections', name: 'Acme Sections', version: '1.0.0' },
    });
    expect(saved).toEqual([{ href: 'blob:package', download: 'acme-sections-1.0.0.typeroll' }]);
    expect(container.textContent).toContain('Saved acme-sections-1.0.0.typeroll.');
  });

  it('shows an export error with its details', async () => {
    request.mockImplementation(async () => reply(403, { error: 'Exporting the whole site needs a site admin', code: 'forbidden', details: ['selection.kind'] }));
    await mount(createElement(PackageExport, { siteId: 'site-1', canEdit: true, isAdmin: true, initial: exportable }));
    await click(labelled('Whole site'));
    await type(labelled('Name'), 'My site');
    await click(button('Export package')!);
    const alert = [...container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' ');
    expect(alert).toContain('Exporting the whole site needs a site admin');
    expect(alert).toContain('selection.kind');
  });
});

const template = (id: string, extra: Partial<BlockTemplate> = {}): BlockTemplate => ({
  id, name: id, blocks: [{ id: `${id}-1`, type: 'core/section', data: {} }], created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z', ...extra,
} as BlockTemplate);

describe('BlockTemplateList', () => {
  it('groups templates by category with kind, preview and the package they came from', () => {
    const html = renderToString(createElement(BlockTemplateList, { siteId: 'site-1', canEdit: true, initial: [
      template('Hero', { kind: 'section', category: 'Heroes', preview: 'https://media.example/hero.jpg', imported_from: { package_id: 'acme', package_name: 'Acme Sections', version: '1.2.0', imported_at: '2026-11-07T10:00:00.000Z' } }),
      template('Quote', { kind: 'block' }),
    ] }));
    expect(html).toMatch(/<h3 class="gb-category">Heroes<\/h3>[\s\S]*Hero[\s\S]*<h3 class="gb-category">Other<\/h3>[\s\S]*Quote/);
    expect(html).toContain('src="https://media.example/hero.jpg"');
    expect(html).toContain('>Section</span>');
    expect(html).toContain('>Block</span>');
    expect(html).toContain('From Acme Sections 1.2.0');
  });

  it('shows no category headings when no template has one', () => {
    expect(renderToString(createElement(BlockTemplateList, { siteId: 'site-1', canEdit: true, initial: [template('A'), template('B')] }))).not.toContain('class="gb-category"');
  });

  it('points to the Packages page when there are no templates', () => {
    expect(renderToString(createElement(BlockTemplateList, { siteId: 'site-1', canEdit: true, initial: [] }))).toContain('href="/app/sites/site-1/packages"');
  });
});

describe('MediaLibrary demo content', () => {
  const media = (id: string, demo?: boolean): Media => ({ id, filename: `${id}.jpg`, cdn_url: `https://media.example/${id}.jpg`, content_type: 'image/jpeg', created_at: '2026-11-01T10:00:00.000Z', demo } as Media);

  it('marks demo files and asks for them to be replaced before publishing', () => {
    const html = renderToString(createElement(MediaLibrary, { siteId: 'site-1', initialItems: [media('hero', true), media('logo')] }));
    expect(html.match(/class="media__demo"/g)).toHaveLength(2); // the notice and one badge
    expect(html).toContain('1 file came<!-- --> with a package as demo content');
  });

  it('shows no notice without demo files', () => {
    expect(renderToString(createElement(MediaLibrary, { siteId: 'site-1', initialItems: [media('logo')] }))).not.toMatch(/class="media__demo/);
  });
});
