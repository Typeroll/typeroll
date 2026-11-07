// @vitest-environment happy-dom
// The organization collection page, the block editor's Collection section,
// Save to collection on the block template list, and the Members page.
// Every API call is a mocked fetch, so nothing reaches the network. The
// helpers are covered in collection-models.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { BlockTemplate } from '@typeroll/shared';
import OrganizationCollection from '../../components/OrganizationCollection';
import { CollectionLibrarySection, useEditorCollection, type EditorCollection } from '../../components/CollectionLibrarySection';
import BlockTemplateList from '../../components/BlockTemplateList';
import OrganizationMembers from '../../components/OrganizationMembers';
import type { OrganizationMember } from '../../components/members-model';
import { collectionEntries, entry, insertReport } from './collection-fixtures';
import { exportable } from './package-fixtures';

let root: Root | undefined;
let container: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function mount(element: ReactElement) {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const buttons = (text: string, scope: ParentNode = container) => [...scope.querySelectorAll('button')].filter(item => item.textContent?.trim() === text || item.textContent?.includes(text));
const button = (text: string, scope?: ParentNode) => buttons(text, scope)[0];
const card = (name: string) => [...container.querySelectorAll('article')].find(item => item.getAttribute('aria-label') === name)!;
const click = async (target: Element) => act(async () => { (target as HTMLElement).click(); });
const setValue = async (target: HTMLInputElement | HTMLSelectElement, value: string) => act(async () => {
  const proto = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(target, value);
  target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const byLabel = (text: string) => {
  const label = [...container.querySelectorAll('label')].find(item => item.textContent?.trim().startsWith(text))!;
  return (label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input, select')) as HTMLInputElement;
};
const calls = (suffix: string, method?: string) => request.mock.calls.filter(call => String(call[0]).endsWith(suffix) && (!method || ((call[1] as RequestInit | undefined)?.method ?? 'GET') === method));
const jsonOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request = vi.fn(async () => reply(404, { error: 'Not found' }));
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OrganizationCollection', () => {
  it('loads the entries, groups them by kind and category, and marks built-ins read-only', async () => {
    request.mockImplementation(async () => reply(200, { entries: collectionEntries() }));
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, siteNames: { 'site-1': 'Café' } }));
    await flush();
    expect(calls('/api/sites/site-1/collection')).toHaveLength(1);
    const headings = [...container.querySelectorAll('h2')].map(item => item.textContent);
    expect(headings).toEqual(expect.arrayContaining(['Sections (2)', 'Block templates (1)', 'Global blocks (1)', 'Page templates (1)', 'Block types (1)']));
    expect(container.textContent).toContain('never mapped to the site’s nearest styles');

    const hero = card('Hero Split');
    expect(hero.querySelector('img')!.getAttribute('src')).toBe('https://media.example/hero.jpg');
    expect(hero.textContent).toContain('Saved from Café');
    expect(hero.textContent).toContain('4 blocks · 2 styles · 1 media file');
    expect(button('Edit', hero)).toBeTruthy();
    expect(button('Delete', hero)).toBeTruthy();

    const builtin = card('Feature page');
    expect(builtin.textContent).toContain('Read-only');
    expect(builtin.textContent).toContain('Typeroll built-in');
    expect(builtin.textContent).toContain('✓ Verified');
    expect(button('Edit', builtin)).toBeUndefined();
    expect(button('Delete', builtin)).toBeUndefined();
    expect(button('Insert into a page…', builtin)).toBeTruthy();

    expect(card('Site header').textContent).toContain('From Acme Sections 1.2.0 · Acme Studio ✓ Verified');
    expect(button('Insert into a page…', card('Article'))).toBeUndefined();
    expect(button('Add to this site’s page templates', card('Article'))).toBeTruthy();
  });

  it('filters by source and search', async () => {
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: collectionEntries() } }));
    await click(button('Typeroll'));
    expect([...container.querySelectorAll('article')].map(item => item.getAttribute('aria-label'))).toEqual(['Feature page', 'Article']);
    await click(button('All'));
    await setValue(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'pricing');
    expect([...container.querySelectorAll('article')].map(item => item.getAttribute('aria-label'))).toEqual(['Pricing Row']);
    await setValue(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'nothing like this');
    expect(container.textContent).toContain('Nothing matches');
  });

  it('explains the collection is not available on a 404, or without asking when the page knows', async () => {
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true }));
    await flush();
    expect(container.textContent).toContain('owners, administrators and builders');
    request.mockClear();
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, available: false }));
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain('shared with you from another organization');
  });

  it('adds an entry to the site and reports created, reused and renamed styles with links', async () => {
    request.mockImplementation(async () => reply(200, insertReport()));
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: collectionEntries() } }));
    await click(button('Add to this site’s templates', card('Hero Split')));
    const insert = calls('/api/sites/site-1/collection/hero-split/insert', 'POST');
    expect(insert).toHaveLength(1);
    expect(jsonOf(insert[0])).toEqual({ target: 'library' });
    const status = container.querySelector('.pk-report')!;
    expect(status.textContent).toContain('Added Hero Split to this site.');
    expect(status.textContent).toContain('hero-title → hero-title-2');
    expect(status.textContent).toContain('demo content');
    expect(status.querySelector('a[href="/app/sites/site-1/styles"]')).toBeTruthy();
  });

  it('inserts an entry at the end of a chosen page and links to it', async () => {
    request.mockImplementation(async (url: string) => String(url).includes('/pages')
      ? reply(200, { pages: [{ id: 'home', title: 'Home', url: '/' }, { id: 'about', title: 'About', url: '/about/' }] })
      : reply(200, insertReport()));
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: collectionEntries() } }));
    await click(button('Insert into a page…', card('Hero Split')));
    await flush();
    expect(calls('/api/sites/site-1/pages?include_unrouted=true')).toHaveLength(1);
    await setValue(card('Hero Split').querySelector('select')!, 'about');
    await click(button('Insert', card('Hero Split').querySelector('form')!));
    expect(jsonOf(calls('/collection/hero-split/insert', 'POST')[0])).toEqual({ target: 'page', page_id: 'about' });
    const link = container.querySelector<HTMLAnchorElement>('.pk-report a[href="/app/sites/site-1/pages/about"]')!;
    expect(link.textContent).toBe('About');
  });

  it('shows an insert refusal', async () => {
    request.mockImplementation(async () => reply(409, { error: 'The block type acme/card is missing', details: ['Install it first'] }));
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: collectionEntries() } }));
    await click(button('Add to this site’s templates', card('Hero Split')));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('The block type acme/card is missing');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Install it first');
  });

  it('hides inserting without write access', async () => {
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: false, initial: { entries: collectionEntries() } }));
    expect(button('Insert into a page…')).toBeUndefined();
    expect(button('Add to this site’s templates')).toBeUndefined();
  });

  it('edits and deletes the organization’s own entries', async () => {
    request.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'PATCH'
      ? reply(200, { entry: entry('hero-split', { name: 'Big hero', category: 'Heroes' }) })
      : reply(200, { deleted: true }));
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: collectionEntries() } }));
    await click(button('Edit', card('Hero Split')));
    const form = container.querySelector('form[aria-label="Edit Hero Split"]')!;
    await setValue(byLabel('Name'), 'Big hero');
    await click(form.querySelector('button[type="submit"]')!);
    expect(jsonOf(calls('/collection/hero-split', 'PATCH')[0])).toEqual({ name: 'Big hero' });
    expect(card('Big hero')).toBeTruthy();

    await click(button('Delete', card('Big hero')));
    expect(confirm).toHaveBeenCalled();
    expect(calls('/collection/hero-split', 'DELETE')).toHaveLength(1);
    expect(card('Big hero')).toBeUndefined();
  });

  it('imports a .typeroll file into the collection and lists its warnings', async () => {
    request.mockImplementation(async () => reply(200, { entries: [entry('cafe-menu', { name: 'Café menu', source: { type: 'package', package_name: 'Café pack' } })], warnings: ['Two fonts were left out.'] }));
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: [] } }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain('.typeroll');
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(64)], 'cafe.typeroll')], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    const post = calls('/api/sites/site-1/collection/import', 'POST');
    expect(post).toHaveLength(1);
    expect(((post[0][1] as RequestInit).body as FormData).get('file')).toBeInstanceOf(File);
    expect(container.textContent).toContain('Added 1 entry to the collection.');
    expect(container.textContent).toContain('Two fonts were left out.');
    expect(card('Café menu')).toBeTruthy();
  });

  it('refuses a file that is not a package without uploading it', async () => {
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: [] } }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(4)], 'notes.zip')], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(request).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('.typeroll');
  });

  it('saves an item of this site to the collection with a category', async () => {
    request.mockImplementation(async (url: string) => String(url).endsWith('/packages/exportable')
      ? reply(200, exportable)
      : reply(201, { entry: entry('hero-copy', { name: 'Hero', category: 'Landing' }) }));
    await mount(createElement(OrganizationCollection, { siteId: 'site-1', canEdit: true, initial: { entries: [] } }));
    await click(button('Save from this site…'));
    await flush();
    expect(calls('/api/sites/site-1/packages/exportable')).toHaveLength(1);
    await setValue(byLabel('What to save'), 'section:hero');
    expect(byLabel('Name in the collection').value).toBe('Hero');
    await setValue(byLabel('Category'), 'Landing');
    await click(button('Save to collection'));
    expect(jsonOf(calls('/api/sites/site-1/collection/save', 'POST')[0])).toEqual({ kind: 'section', id: 'hero', name: 'Hero', category: 'Landing' });
    expect(container.textContent).toContain('Saved “Hero” to the collection.');
    expect(card('Hero')).toBeTruthy();
  });
});

describe('the block editor’s Collection section', () => {
  it('renders nothing until the collection loads', () => {
    expect(renderToString(createElement(CollectionLibrarySection, { siteId: 'site-1', entries: null, filter: '', onInsert: vi.fn() }))).toBe('');
  });

  it('lists only entries that place blocks, filtered, and inserts one', async () => {
    const onInsert = vi.fn(async () => insertReport());
    await mount(createElement(CollectionLibrarySection, { siteId: 'site-1', entries: collectionEntries(), filter: '', onInsert }));
    const names = [...container.querySelectorAll('button strong')].map(item => item.firstChild?.textContent);
    expect(names).toEqual(['Hero Split', 'Feature page', 'Pricing Row', 'Site header']);
    expect(container.textContent).toContain('never mapped to the nearest style');
    expect(container.querySelector('a[href="/app/sites/site-1/collection"]')).toBeTruthy();
    await click(button('Site header'));
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'site-header' }));
    expect(container.querySelector('[role="status"]')!.textContent).toBe('Inserted Site header. Styles: created 1 style; renamed hero-title → hero-title-2.');

    await mount(createElement(CollectionLibrarySection, { siteId: 'site-1', entries: collectionEntries(), filter: 'pricing', onInsert }));
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('shows an insert error', async () => {
    await mount(createElement(CollectionLibrarySection, { siteId: 'site-1', entries: collectionEntries(), filter: '', onInsert: async () => { throw new Error('The page is locked'); } }));
    await click(button('Hero Split'));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('The page is locked');
  });

  it('loads the collection once, stays empty on 404, and posts save and page inserts', async () => {
    let api: EditorCollection | undefined;
    function Probe() { api = useEditorCollection('site-1'); return null; }
    await mount(createElement(Probe));
    await flush();
    expect(api!.entries).toBeNull();

    request.mockImplementation(async (url: string) => String(url).endsWith('/collection')
      ? reply(200, { entries: [entry('hero')] })
      : String(url).endsWith('/save') ? reply(201, { entry: entry('quote') }) : reply(200, insertReport()));
    await mount(createElement(Probe));
    await flush();
    expect(api!.entries!.map(item => item.id)).toEqual(['hero']);
    await act(async () => { await api!.save('block_template', 'quote', { name: 'Quote', description: ' ', category: 'Quotes' }); });
    expect(jsonOf(calls('/collection/save', 'POST')[0])).toEqual({ kind: 'block_template', id: 'quote', name: 'Quote', category: 'Quotes' });
    expect(api!.entries!.map(item => item.id)).toEqual(['hero', 'quote']);
    await act(async () => { await api!.insertIntoPage('hero', 'home', 'b2'); });
    expect(jsonOf(calls('/collection/hero/insert', 'POST')[0])).toEqual({ target: 'page', page_id: 'home', after_block_id: 'b2' });
    await act(async () => { await api!.insertIntoPage('hero', 'home', null); });
    expect(jsonOf(calls('/collection/hero/insert', 'POST')[1])).toEqual({ target: 'page', page_id: 'home' });
  });
});

describe('BlockTemplateList Save to collection', () => {
  const template = (id: string, kind?: 'block' | 'section'): BlockTemplate => ({ id, name: id, kind, blocks: [], created_at: '2026-11-07T10:00:00.000Z', updated_at: '2026-11-07T10:00:00.000Z' });

  it('is offered only when the person can use the collection', () => {
    expect(renderToString(createElement(BlockTemplateList, { siteId: 'site-1', canEdit: true, initial: [template('hero')] }))).not.toContain('Save to collection');
    expect(renderToString(createElement(BlockTemplateList, { siteId: 'site-1', canEdit: true, canUseCollection: true, initial: [template('hero')] }))).toContain('Save to collection');
  });

  it('saves a section with its kind and links to the collection', async () => {
    request.mockImplementation(async () => reply(201, { entry: entry('hero') }));
    await mount(createElement(BlockTemplateList, { siteId: 'site-1', canEdit: true, canUseCollection: true, initial: [template('hero', 'section'), template('quote')] }));
    await click(buttons('Save to collection')[0]);
    expect(jsonOf(calls('/api/sites/site-1/collection/save', 'POST')[0])).toEqual({ kind: 'section', id: 'hero' });
    expect(container.querySelector('a[href="/app/sites/site-1/collection"]')).toBeTruthy();
    await click(buttons('Save to collection')[1]);
    expect(jsonOf(calls('/collection/save', 'POST')[1])).toEqual({ kind: 'block_template', id: 'quote' });
  });
});

describe('OrganizationMembers', () => {
  const members = (): OrganizationMember[] => [
    { id: 'u-owner', email: 'owner@example.com', display_name: 'Olga Owner', role: 'owner', joined_at: '2026-01-02T10:00:00.000Z' },
    { id: 'u-ed', email: 'ed@example.com', role: 'editor', joined_at: '2026-03-02T10:00:00.000Z' },
  ];

  it('shows a non-admin their own role only', async () => {
    await mount(createElement(OrganizationMembers, { orgId: 'org-1', organizationName: 'Acme', currentUserId: 'u-b', currentRole: 'builder', canManage: false }));
    expect(container.textContent).toContain('Builder in Acme.');
    expect(container.textContent).toContain('no members, billing or publishing connections');
    expect(container.querySelector('select')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('lists members with roles and changes a role', async () => {
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/orgs/org-1/members')) return reply(200, { members: members() });
      if (init?.method === 'PATCH') return reply(200, { member: { ...members()[1], role: 'builder' } });
      return reply(200, { invites: [] });
    });
    await mount(createElement(OrganizationMembers, { orgId: 'org-1', currentUserId: 'u-owner', currentRole: 'owner', canManage: true }));
    await flush();
    const rows = [...container.querySelectorAll('.mb-row')];
    expect(rows[0].textContent).toContain('Olga Owner');
    expect(rows[0].textContent).toContain('You');
    expect(rows[0].querySelector('button')).toBeNull(); // no Remove on your own row
    const select = byLabel('Role for ed@example.com') as unknown as HTMLSelectElement;
    expect([...select.options].map(option => option.textContent)).toEqual(['Owner', 'Administrator', 'Builder', 'Editor']);
    await setValue(select, 'builder');
    expect(jsonOf(calls('/api/orgs/org-1/members/u-ed', 'PATCH')[0])).toEqual({ role: 'builder' });
    expect(container.textContent).toContain('ed@example.com is now Builder.');
  });

  it('shows the last-owner refusal and keeps the role', async () => {
    request.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'PATCH'
      ? reply(409, { error: 'last owner', code: 'last_owner' })
      : reply(200, { invites: [] }));
    await mount(createElement(OrganizationMembers, { orgId: 'org-1', currentUserId: 'u-x', canManage: true, initial: { members: members() } }));
    const select = byLabel('Role for Olga Owner') as unknown as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['owner', 'admin', 'builder', 'editor']);
    await setValue(select, 'admin');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('at least one owner');
    expect(select.value).toBe('owner');
  });

  it('removes a member after confirming', async () => {
    request.mockImplementation(async () => reply(200, { removed: true }));
    await mount(createElement(OrganizationMembers, { orgId: 'org-1', currentUserId: 'u-owner', canManage: true, initial: { members: members() } }));
    await click(container.querySelector('button[aria-label="Remove ed@example.com"]')!);
    expect(confirm).toHaveBeenCalled();
    expect(calls('/api/orgs/org-1/members/u-ed', 'DELETE')).toHaveLength(1);
    expect(container.textContent).not.toContain('Joined 2 Mar 2026');
  });

  it('invites with Editor by default and with a chosen role', async () => {
    request.mockImplementation(async (url: string) => String(url).endsWith('/generate')
      ? reply(200, { inviteId: 'i1', inviteUrl: 'https://portal.example/onboarding?invite=abc', expiresAt: '2026-11-14T10:00:00.000Z', maxUses: 1, email: null })
      : reply(200, { invites: [] }));
    await mount(createElement(OrganizationMembers, { orgId: 'org-1', currentUserId: 'u-owner', canManage: true, initial: { members: members(), invites: [] } }));
    const editor = container.querySelector<HTMLInputElement>('input[type="radio"][value="editor"]')!;
    expect(editor.checked).toBe(true);
    await click(button('Create invite link'));
    expect(jsonOf(calls('/api/orgs/invite/generate', 'POST')[0])).toEqual({ role: 'editor', ttlDays: 7, max_uses: 1 });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')!.value).toBe('https://portal.example/onboarding?invite=abc');

    await click(container.querySelector<HTMLInputElement>('input[type="radio"][value="builder"]')!);
    await setValue(byLabel('Only for this email'), 'bo@example.com');
    await click(button('Create invite link'));
    expect(jsonOf(calls('/api/orgs/invite/generate', 'POST')[1])).toEqual({ role: 'builder', ttlDays: 7, max_uses: 1, email: 'bo@example.com' });
    expect(container.textContent).toContain('Invite link for Builder');
  });
});
