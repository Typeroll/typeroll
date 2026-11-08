// Menus over the v1 API: create, read, revision-checked replace, location
// uniqueness, history, usage, delete, per-version storage and branch merge.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Menu, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const BRANCH = 'feature';
let token = '';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(paths.version(ORG, SITE, BRANCH), {
    name: 'Feature', kind: 'branch', base_version_id: MAIN_VERSION_ID, created_at: new Date().toISOString(), robots_blocked: true,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  token = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' })).token;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function call(route: string, method: Method, url: string, params: Record<string, string>, body?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/menus/${route}`)) as Partial<Record<string, APIRoute>>;
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/menus${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request: req, params: { siteId: SITE, ...params }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const q = (version?: string) => (version ? `?version=${version}` : '');
const list = (version?: string) => call('index', 'GET', q(version), {});
const create = (body: unknown, version?: string) => call('index', 'POST', q(version), {}, body);
const read = (menuId: string, version?: string) => call('[menuId]', 'GET', `/${menuId}${q(version)}`, { menuId });
const replace = (menuId: string, body: unknown) => call('[menuId]', 'PUT', `/${menuId}`, { menuId }, body);
const remove = (menuId: string, version?: string) => call('[menuId]', 'DELETE', `/${menuId}${q(version)}`, { menuId });
const usage = (menuId: string) => call('[menuId]/usage', 'GET', `/${menuId}/usage`, { menuId });
const revisions = (menuId: string) => call('[menuId]/revisions/index', 'GET', `/${menuId}/revisions`, { menuId });
const revision = (menuId: string, revId: string) => call('[menuId]/revisions/[revId]', 'GET', `/${menuId}/revisions/${revId}`, { menuId, revId });
const restore = (menuId: string, revId: string) => call('[menuId]/revisions/[revId]/restore', 'POST', `/${menuId}/revisions/${revId}/restore`, { menuId, revId }, {});

const items = [
  { id: 'home', type: 'page', page_id: 'home' },
  { id: 'docs', type: 'url', href: '/docs/', label: 'Docs', children: [{ type: 'url', href: 'https://example.com', label: 'Example' }] },
];

describe('menus over the v1 API', () => {
  beforeEach(async () => { await setup(); });

  it('creates menus with derived or given ids and lists them', async () => {
    const first = await create({ name: 'Huvudmeny', locations: ['primary'], items });
    expect(first.status).toBe(201);
    const { menu } = await first.json() as { menu: Menu };
    expect(menu).toMatchObject({ id: 'huvudmeny', name: 'Huvudmeny', locations: ['primary'] });
    expect(menu.created_at).toBe(menu.updated_at);
    // Items without an id get one.
    expect(menu.items[1]!.children![0]!.id).toMatch(/^item-\d+$/);

    expect((await (await create({ name: 'Huvudmeny', items: [] })).json() as { menu: Menu }).menu.id).toBe('huvudmeny-2');
    expect((await create({ id: 'footer-menu', name: 'Footer', items: [] })).status).toBe(201);
    expect((await create({ id: 'footer-menu', name: 'Again', items: [] })).status).toBe(409);
    expect((await create({ id: 'Not Valid', name: 'Bad', items: [] })).status).toBe(400);
    const invalid = await create({ name: 'Bad', items: [{ id: 'x', type: 'url' }] });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { details: { errors: Array<{ path: string }> } }).details.errors.map((e) => e.path)).toContain('items[0].href');

    const listed = await (await list()).json() as { menus: Menu[] };
    expect(listed.menus.map((m) => m.id)).toEqual(['footer-menu', 'huvudmeny', 'huvudmeny-2']);
    expect((await read('huvudmeny')).status).toBe(200);
    expect((await read('missing')).status).toBe(404);
  });

  it('refuses a location another menu fills and names that menu', async () => {
    await create({ id: 'main', name: 'Main menu', locations: ['primary'], items: [] });
    const taken = await create({ name: 'Other', locations: ['footer', 'primary'], items: [] });
    expect(taken.status).toBe(409);
    expect((await taken.json() as { error: string }).error).toContain('"Main menu" (main)');
    await create({ id: 'other', name: 'Other', locations: ['footer'], items: [] });
    expect((await replace('other', { name: 'Other', locations: ['primary'], items: [] })).status).toBe(409);
    // A menu keeps its own locations on save.
    expect((await replace('main', { name: 'Main menu', locations: ['primary', 'mobile'], items: [] })).status).toBe(200);
  });

  it('moves a taken location to a new or replaced menu with take_locations, keeping the other menu', async () => {
    await create({ id: 'primary', name: 'Main menu', locations: ['primary', 'mobile'], auto_add_pages: true, items });
    await create({ id: 'footer', name: 'Footer menu', locations: ['footer'], items: [] });
    const refused = await create({ name: 'Huvudmeny', locations: ['primary'], items: [] });
    expect((await refused.json() as { error: string }).error).toContain('take_locations: true');
    expect((await create({ name: 'Huvudmeny', locations: ['primary'], take_locations: 'yes', items: [] })).status).toBe(400);
    // An invalid menu takes nothing.
    expect((await create({ name: 'Bad', locations: ['primary'], take_locations: true, items: [{ id: 'x', type: 'url' }] })).status).toBe(400);
    expect((await (await read('primary')).json() as { menu: Menu }).menu.locations).toEqual(['primary', 'mobile']);

    const created = await create({ name: 'Huvudmeny', locations: ['primary'], take_locations: true, items: [{ type: 'url', href: '/meny/', label: 'Meny' }] });
    expect(created.status).toBe(201);
    const body = await created.json() as { menu: Menu; moved_locations: unknown };
    expect(body.menu).toMatchObject({ id: 'huvudmeny', locations: ['primary'] });
    expect(body.menu).not.toHaveProperty('take_locations');
    expect(body.moved_locations).toEqual([{ location: 'primary', from_menu_id: 'primary' }]);
    const starter = (await (await read('primary')).json() as { menu: Menu }).menu;
    expect(starter).toMatchObject({ locations: ['mobile'], auto_add_pages: true });
    expect(starter.items).toHaveLength(items.length);
    const history = await (await revisions('primary')).json() as { revisions: Array<{ note?: string }> };
    expect(history.revisions.some((entry) => entry.note?.includes('moved to the menu huvudmeny'))).toBe(true);

    const current = (await (await read('huvudmeny')).json() as { menu: Menu }).menu;
    const replaced = await replace('huvudmeny', { name: 'Huvudmeny', locations: ['primary', 'footer'], take_locations: true, items: current.items, expected_updated_at: current.updated_at });
    expect(replaced.status).toBe(200);
    expect((await replaced.json() as { moved_locations: unknown }).moved_locations).toEqual([{ location: 'footer', from_menu_id: 'footer' }]);
    expect((await (await read('footer')).json() as { menu: Menu }).menu.locations).toEqual([]);
  });

  it('replaces the whole menu, checks expected_updated_at and keeps revisions', async () => {
    const { menu } = await (await create({ id: 'main', name: 'Main', items })).json() as { menu: Menu };
    const saved = await replace('main', { name: 'Main 2', items: [items[0]], expected_updated_at: menu.updated_at, created_at: 'ignored' });
    expect(saved.status).toBe(200);
    const next = (await saved.json() as { menu: Menu }).menu;
    expect(next).toMatchObject({ id: 'main', name: 'Main 2', created_at: menu.created_at });
    expect(next.items).toHaveLength(1);

    const stale = await replace('main', { name: 'Lost', items: [], expected_updated_at: menu.updated_at });
    expect(stale.status).toBe(409);
    expect((await replace('missing', { name: 'x', items: [] })).status).toBe(404);
    expect((await replace('main', { name: '', items: [] })).status).toBe(400);

    const history = await (await revisions('main')).json() as { revisions: Array<{ id: string; name: string; item_count: number }>; total: number };
    expect(history.total).toBe(1);
    expect(history.revisions[0]).toMatchObject({ name: 'Main', item_count: 2 });
    const revId = history.revisions[0]!.id;
    const one = await (await revision('main', revId)).json() as { revision: { id: string; doc: Menu } };
    expect(one.revision.doc.items).toHaveLength(2);

    const restored = await restore('main', revId);
    expect(restored.status).toBe(200);
    expect((await (await read('main')).json() as { menu: Menu }).menu).toMatchObject({ name: 'Main', created_at: menu.created_at });
    expect((await (await revisions('main')).json() as { total: number }).total).toBe(2);
    expect((await restore('main', 'missing')).status).toBe(404);
    expect((await revision('main', 'missing')).status).toBe(404);
    expect((await revisions('missing')).status).toBe(404);
  });

  it('reports which pages, templates and partials show the menu by id or location', async () => {
    await create({ id: 'main', name: 'Main', locations: ['primary'], items: [] });
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    const nav = (menu: string) => ({ id: `nav-${menu}`, type: 'core/navigation_links', data: { source: 'menu', menu } });
    await store.setDoc(paths.partial(ORG, SITE, 'header', MAIN_VERSION_ID), {
      name: 'Header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [{ id: 'row', type: 'core/row', data: {}, children: [nav('location:primary')] }],
    });
    await store.setDoc(paths.page(ORG, SITE, 'about', MAIN_VERSION_ID), {
      title: 'About', slug: 'about', status: 'published', content_mode: 'blocks', blocks: [nav('main')],
    });
    await store.setDoc(paths.page(ORG, SITE, 'other', MAIN_VERSION_ID), {
      title: 'Other', slug: 'other', status: 'published', content_mode: 'blocks',
      blocks: [nav('location:footer'), { id: 'links', type: 'core/navigation_links', data: { menu: 'main' } }],
    });
    await store.setDoc(paths.pageTemplate(ORG, SITE, 'article', MAIN_VERSION_ID), {
      name: 'article', label: 'Article', status: 'published', blocks: [nav('main')],
    });
    const body = await (await usage('main')).json() as { menu_id: string; locations: string[]; pages: Array<{ page_id: string }>; templates: Array<{ template_id: string }>; global_blocks: Array<{ partial_id: string }> };
    expect(body).toMatchObject({ menu_id: 'main', locations: ['primary'] });
    expect(body.pages.map((p) => p.page_id)).toEqual(['about']);
    expect(body.templates.map((t) => t.template_id)).toEqual(['article']);
    expect(body.global_blocks.map((p) => p.partial_id)).toEqual(['header']);
    expect((await usage('missing')).status).toBe(404);
  });

  it('stores menus per version: a branch inherits, overrides and deletes without touching main', async () => {
    await create({ id: 'main', name: 'Main', items: [] });
    expect((await (await list(BRANCH)).json() as { menus: Menu[] }).menus.map((m) => m.id)).toEqual(['main']);
    expect((await create({ id: 'branch-only', name: 'Branch only', items: [] }, BRANCH)).status).toBe(201);
    expect((await read('branch-only')).status).toBe(404);
    expect((await remove('main', BRANCH)).status).toBe(200);
    expect((await read('main', BRANCH)).status).toBe(404);
    expect((await read('main')).status).toBe(200);
    expect((await remove('main', BRANCH)).status).toBe(404);

    const { diffVersion, promoteBranch } = await import('../../lib/version-promote');
    const diff = await diffVersion(ORG, SITE, BRANCH);
    expect(diff.menus).toEqual({ added: ['branch-only'], modified: [], deleted: ['main'] });
    await promoteBranch(ORG, SITE, BRANCH);
    expect((await (await list()).json() as { menus: Menu[] }).menus.map((m) => m.id)).toEqual(['branch-only']);
    // Promotion snapshots main's menu before deleting it.
    const { listRevisions } = await import('../../lib/revisions');
    expect(await listRevisions({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, kind: 'menu', resourceIds: ['main'] })).toHaveLength(1);
  });

  it('deletes a menu', async () => {
    await create({ id: 'main', name: 'Main', items: [] });
    expect((await remove('main')).status).toBe(200);
    expect((await read('main')).status).toBe(404);
    expect((await remove('main')).status).toBe(404);
  });
});
