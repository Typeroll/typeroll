// The portal's session routes for the menu editor: the owner's tree is used
// (owner_org_id, not the session's org), writes need write permission, and
// they share the v1 save path (validation, locations, revisions).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Menu } from '@typeroll/shared';

const OWNER = 'ownerorg';
const VIEWER = 'partnerorg';
const SITE = 'mysite';
let permission: 'read' | 'write' = 'write';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  permission = 'write';
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: VIEWER, userId: 'u1', email: 'editor@example.com' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID, owner_org_id: OWNER, permission,
        },
      })),
    };
  });
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function call(route: string, method: Method, params: Record<string, string> = {}, body?: unknown, form?: FormData): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/sites/[siteId]/menus/${route}`)) as Partial<Record<string, APIRoute>>;
  const request = new Request(`http://localhost/api/sites/${SITE}/menus`, {
    method, ...(form ? { body: form } : { headers: { 'content-type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined }),
  });
  return mod[method]!({
    request, params: { siteId: SITE, ...params }, cookies: { get: () => undefined }, locals: {},
    redirect: (to: string) => new Response(null, { status: 302, headers: { location: to } }),
  } as never) as Promise<Response>;
}

describe('menu session routes', () => {
  it('moves a taken location with take_locations, as the v1 routes do', async () => {
    await call('index', 'POST', {}, { id: 'primary', name: 'Main menu', locations: ['primary'], items: [{ id: 'home', type: 'page', page_id: 'home' }] });
    await call('index', 'POST', {}, { id: 'footer', name: 'Footer menu', locations: ['footer'] });
    expect((await call('index', 'POST', {}, { name: 'Huvudmeny', locations: ['primary'] })).status).toBe(409);
    expect((await call('index', 'POST', {}, { name: 'Huvudmeny', locations: ['primary'], take_locations: 1 })).status).toBe(400);
    const created = await call('index', 'POST', {}, { name: 'Huvudmeny', locations: ['primary'], take_locations: true });
    expect(created.status).toBe(201);
    const body = await created.json() as { menu: Menu; moved_locations: unknown };
    expect(body.menu).toMatchObject({ id: 'huvudmeny', locations: ['primary'] });
    expect(body.moved_locations).toEqual([{ location: 'primary', from_menu_id: 'primary' }]);
    const starter = (await (await call('[menuId]', 'GET', { menuId: 'primary' })).json() as { menu: Menu }).menu;
    expect(starter).toMatchObject({ locations: [], items: [{ id: 'home' }] });

    const replaced = await call('[menuId]', 'PUT', { menuId: 'huvudmeny' }, {
      name: 'Huvudmeny', locations: ['primary', 'footer'], items: [], take_locations: true, expected_updated_at: body.menu.updated_at,
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json() as { moved_locations: unknown }).moved_locations).toEqual([{ location: 'footer', from_menu_id: 'footer' }]);

    const form = new FormData();
    form.set('name', 'Mobil');
    form.set('location', 'primary');
    expect((await call('create', 'POST', {}, undefined, form)).status).toBe(409);
    form.set('take_locations', 'true');
    expect((await call('create', 'POST', {}, undefined, form)).headers.get('location')).toBe(`/app/sites/${SITE}/menus/mobil`);
    expect((await (await call('[menuId]', 'GET', { menuId: 'huvudmeny' })).json() as { menu: Menu }).menu.locations).toEqual(['footer']);
  });

  it('takes over a location the New menu form offers as move:<location>', async () => {
    await call('index', 'POST', {}, { id: 'primary', name: 'Main menu', locations: ['primary'], items: [{ id: 'home', type: 'page', page_id: 'home' }] });
    const form = new FormData();
    form.set('name', 'Huvudmeny');
    form.set('location', 'move:primary');
    expect((await call('create', 'POST', {}, undefined, form)).headers.get('location')).toBe(`/app/sites/${SITE}/menus/huvudmeny`);
    expect((await (await call('[menuId]', 'GET', { menuId: 'huvudmeny' })).json() as { menu: Menu }).menu.locations).toEqual(['primary']);
    expect((await (await call('[menuId]', 'GET', { menuId: 'primary' })).json() as { menu: Menu }).menu).toMatchObject({ locations: [], items: [{ id: 'home' }] });
  });

  it('creates, saves, restores and deletes in the owner organization', async () => {
    const created = await call('index', 'POST', {}, { name: 'Main menu', locations: ['primary'] });
    expect(created.status).toBe(201);
    const { menu } = await created.json() as { menu: Menu };
    expect(menu.id).toBe('main-menu');
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.menu(OWNER, SITE, 'main-menu', MAIN_VERSION_ID))).not.toBeNull();
    expect(await getStore().getDoc(paths.menu(VIEWER, SITE, 'main-menu', MAIN_VERSION_ID))).toBeNull();

    const form = new FormData();
    form.set('name', 'Footer');
    form.set('location', 'primary');
    expect((await call('create', 'POST', {}, undefined, form)).status).toBe(409);
    form.set('location', 'footer');
    const redirected = await call('create', 'POST', {}, undefined, form);
    expect(redirected.headers.get('location')).toBe(`/app/sites/${SITE}/menus/footer`);

    const saved = await call('[menuId]', 'PUT', { menuId: 'main-menu' }, {
      name: 'Main menu', locations: ['primary'], items: [{ id: 'a', type: 'url', href: '/a/', label: 'A' }], expected_updated_at: menu.updated_at,
    });
    expect(saved.status).toBe(200);
    expect((await call('[menuId]', 'PUT', { menuId: 'main-menu' }, { name: 'X', items: [], expected_updated_at: menu.updated_at })).status).toBe(409);
    expect(((await (await call('[menuId]', 'GET', { menuId: 'main-menu' })).json()) as { menu: Menu }).menu.items).toHaveLength(1);

    const { revisions } = await (await call('[menuId]/revisions', 'GET', { menuId: 'main-menu' })).json() as { revisions: Array<{ id: string; created_by: string }> };
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.created_by).toBe('editor@example.com');
    expect((await call('[menuId]/revisions', 'POST', { menuId: 'main-menu' }, { revId: revisions[0]!.id })).status).toBe(200);
    expect(((await (await call('[menuId]', 'GET', { menuId: 'main-menu' })).json()) as { menu: Menu }).menu.items).toHaveLength(0);

    const used = await (await call('[menuId]/usage', 'GET', { menuId: 'main-menu' })).json() as { pages: unknown[] };
    expect(used.pages).toEqual([]);
    expect((await call('[menuId]', 'DELETE', { menuId: 'main-menu' })).status).toBe(200);
    expect((await call('[menuId]', 'GET', { menuId: 'main-menu' })).status).toBe(404);
  });

  it('needs write permission to change menus', async () => {
    permission = 'read';
    expect((await call('index', 'POST', {}, { name: 'Main' })).status).toBe(403);
    expect((await call('[menuId]', 'PUT', { menuId: 'main' }, { name: 'Main', items: [] })).status).toBe(403);
    expect((await call('[menuId]', 'DELETE', { menuId: 'main' })).status).toBe(403);
    expect((await call('index', 'GET')).status).toBe(200);
  });
});
