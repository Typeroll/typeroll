// WordPress menus → Typeroll menus: page links by id, addresses, nesting
// capped at three levels, theme locations, and the import_menus step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_VERSION_ID, paths, validateMenu, type Menu } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { convertWordPressMenu, importedMenuId, isStarterMenu, mapWordPressLocation, type WordPressMenuSource } from '../../lib/wp/menu-import';

const helper = vi.hoisted(() => ({ menus: [] as unknown[], fail: false }));
vi.mock('../../lib/wp/helper-client', () => ({ WPHelperClient: class {
  async menus() { if (helper.fail) throw new Error('HTTP 404'); return helper.menus; }
} }));
vi.mock('../../lib/wp/client', () => ({ WPClient: class {
  async listMenus() { return []; }
  async listMenuItems() { return []; }
} }));

const ORIGIN = 'https://wp.example';
const pages = [
  { id: 'home', title: 'Home', path: '/', old_wp_url: 'https://wp.example/start/' },
  { id: 'wp-page-10', title: 'Services', path: '/services', old_wp_url: 'https://wp.example/services/' },
  { id: 'wp-page-11', title: 'Web design', path: '/services/web', old_wp_url: 'https://wp.example/services/web/' },
  { id: 'wp-post-20', title: 'Launch news', path: '/blog/launch', old_wp_url: 'https://wp.example/2024/05/launch/' },
  { id: 'wp-term-category-5', title: 'News', path: '/category/news', old_wp_url: 'https://wp.example/category/news/' },
];

// A WordPress main menu as the helper exports it (ids, parents and order as in wp_get_nav_menu_items).
const mainMenu: WordPressMenuSource = {
  id: 3, name: 'Main &amp; more', slug: 'main', locations: ['primary', 'mobile-menu', 'sidebar widget'],
  items: [
    { id: 101, title: 'Start', url: 'https://wp.example/', parent: 0, order: 1, object: 'custom', object_id: 101, type: 'custom' },
    { id: 102, title: 'Services', url: 'https://wp.example/services/', parent: 0, order: 2, object: 'page', object_id: 10, type: 'post_type', description: 'What we do' },
    { id: 103, title: 'Web design', url: 'https://wp.example/old-web/', parent: 102, order: 3, object: 'page', object_id: 11, type: 'post_type' },
    { id: 104, title: 'SEO', url: 'https://wp.example/services/seo/', parent: 103, order: 4, object: 'page', object_id: 99, type: 'post_type' },
    { id: 105, title: 'Local SEO', url: 'https://external.example/local', parent: 104, order: 5, type: 'custom' },
    { id: 106, title: 'Resources', url: '#', parent: 0, order: 6, type: 'custom' },
    { id: 107, title: 'News', url: 'https://wp.example/category/news/', parent: 106, order: 7, object: 'category', object_id: 5, type: 'taxonomy' },
    { id: 108, title: 'Launch news', url: 'https://wp.example/2024/05/launch/', parent: 106, order: 8, object: 'post', object_id: 20, type: 'post_type' },
    { id: 109, title: 'Contact', url: 'https://wp.example/#contact', parent: 0, order: 9, type: 'custom' },
    { id: 110, title: 'Orphan', url: 'https://shop.example/', parent: 999, order: 10, type: 'custom' },
  ],
};

describe('convertWordPressMenu', () => {
  it('links imported pages and terms by id, keeps other addresses and caps nesting at three levels', () => {
    const { menu, dropped_locations } = convertWordPressMenu(mainMenu, pages, ORIGIN);
    expect(validateMenu({ ...menu }).errors).toEqual([]);
    expect(menu.id).toBe('wp-main');
    expect(menu.name).toBe('Main & more');
    expect(menu.locations).toEqual(['primary', 'mobile', 'sidebar-widget']);
    expect(dropped_locations).toEqual([]);
    expect(menu.items).toEqual([
      { id: 'wp-101', type: 'page', page_id: 'home', label: 'Start' },
      { id: 'wp-102', type: 'page', page_id: 'wp-page-10', description: 'What we do', children: [
        // Linked by object id although its WordPress address changed.
        { id: 'wp-103', type: 'page', page_id: 'wp-page-11', children: [
          // Not imported: a same-site path. The fourth level moves up into the third.
          { id: 'wp-104', type: 'url', href: '/services/seo/', label: 'SEO' },
          { id: 'wp-105', type: 'url', href: 'https://external.example/local', label: 'Local SEO' },
        ] },
      ] },
      { id: 'wp-106', type: 'heading', label: 'Resources', children: [
        { id: 'wp-107', type: 'page', page_id: 'wp-term-category-5' },
        { id: 'wp-108', type: 'page', page_id: 'wp-post-20' },
      ] },
      { id: 'wp-109', type: 'url', href: '/#contact', label: 'Contact' },
      { id: 'wp-110', type: 'url', href: 'https://shop.example/', label: 'Orphan' },
    ]);
  });

  it('matches by old address or path when the item has no object', () => {
    const { menu } = convertWordPressMenu({ id: 1, name: 'Footer', slug: 'footer', locations: ['footer-1'], items: [
      { id: 1, title: 'Services', url: 'https://wp.example/services', parent: 0, order: 1 },
      { id: 2, title: 'Web', url: '/services/web/', parent: 0, order: 2 },
    ] }, pages, ORIGIN);
    expect(menu.items.map(item => item.page_id)).toEqual(['wp-page-10', 'wp-page-11']);
    expect(menu.locations).toEqual(['footer']);
  });

  it('maps theme location names', () => {
    expect(['primary', 'main-menu', 'header_menu', 'menu-1', 'top', 'footer-2', 'bottom', 'mobile_menu', 'handheld', 'offcanvas', 'social', 'Social Links', '123', ''].map(mapWordPressLocation))
      .toEqual(['primary', 'primary', 'primary', 'primary', 'primary', 'footer', 'footer', 'mobile', 'mobile', 'mobile', 'social', 'social-links', null, null]);
    expect(importedMenuId({ id: 7, slug: '', name: 'Huvudmeny Ö' })).toBe('wp-huvudmeny-o');
    expect(importedMenuId({ id: 7, slug: '%%%', name: '' })).toBe('wp-7');
  });
});

describe('import_menus step', () => {
  const ORG = 'org';
  const SITE = 'site';
  let runStep: (state?: Record<string, unknown>) => Promise<{ logs: string[]; state: Record<string, unknown> }>;

  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore();
    helper.menus = []; helper.fail = false;
    const { getStore } = await import('../../lib/datastore');
    const { migrationWorkflow } = await import('../../lib/workflows/migration');
    const { starterMenus } = await import('../../lib/site-create');
    const store = getStore();
    for (const page of pages) {
      const { id, ...doc } = page;
      await store.setDoc(paths.page(ORG, SITE, id), { ...doc, slug: id, status: 'review', content_mode: 'html', html_content: '' });
    }
    const now = new Date().toISOString();
    for (const { id, ...menu } of starterMenus()) await store.setDoc(paths.menu(ORG, SITE, id), { ...menu, created_at: now, updated_at: now });
    runStep = async (state = {}) => {
      const logs: string[] = [];
      const result = await migrationWorkflow.steps.find(step => step.name === 'import_menus')!.run({
        orgId: ORG, siteId: SITE, workflowId: 'import', store, config: {},
        state: { wp_url: ORIGIN, helper_active: true, helper_api_key: 'test-only-key', ...state },
        log: (line: string) => logs.push(line), setProgress: () => {},
      });
      return { logs, state: (result as { state: Record<string, unknown> }).state };
    };
  });
  afterEach(() => { vi.clearAllMocks(); });

  const menus = async () => {
    const { vstore } = await import('../../lib/version-store');
    return vstore.menus(ORG, SITE, MAIN_VERSION_ID);
  };

  it('runs after extract_content and before redirects', async () => {
    const { migrationWorkflow } = await import('../../lib/workflows/migration');
    const names = migrationWorkflow.steps.map(step => step.name);
    expect(names.indexOf('import_menus')).toBe(names.indexOf('extract_content') + 1);
    expect(names.indexOf('generate_redirects')).toBe(names.indexOf('import_menus') + 1);
  });

  it('imports menus, takes locations from untouched starter menus and is idempotent', async () => {
    helper.menus = [
      { ...mainMenu, items: mainMenu.items.map(({ order, ...item }) => ({ ...item, order, target: '', classes: [] })) },
      { id: 4, name: 'Footer links', slug: 'footer-links', locations: ['footer'], items: [{ id: 201, title: 'Services', url: 'https://wp.example/services/', parent: 0, order: 1, target: '', classes: [] }] },
      // Older helper: no locations, no objects.
      { id: 5, name: 'Legal', slug: 'legal', items: [{ id: 301, title: 'Privacy', url: 'https://wp.example/privacy/', parent: 0, order: 1, target: '', classes: [] }] },
    ];
    const first = await runStep();
    expect((first.state.menus_imported as Array<{ menu_id: string; locations: string[] }>).map(m => [m.menu_id, m.locations])).toEqual([
      ['wp-main', ['primary', 'mobile', 'sidebar-widget']], ['wp-footer-links', ['footer']], ['wp-legal', []],
    ]);
    const saved = await menus();
    const byId = new Map(saved.map((menu: Menu) => [menu.id, menu]));
    expect(byId.get('primary')?.locations).toBeUndefined();
    expect(byId.get('footer')?.locations).toBeUndefined();
    expect(byId.get('wp-main')?.items[1]?.children?.[0]?.children?.map(item => item.id)).toEqual(['wp-104', 'wp-105']);
    expect(byId.get('wp-legal')?.items).toEqual([{ id: 'wp-301', type: 'url', href: '/privacy/', label: 'Privacy' }]);
    expect(first.logs.some(line => line.includes('starter menu "Main menu" no longer fills primary'))).toBe(true);

    const again = await runStep();
    expect(again.state.menus_imported).toEqual([]);
    expect(again.logs.filter(line => line.includes('already imported'))).toHaveLength(3);
    expect((await menus()).length).toBe(5);
  });

  it('keeps a location that an edited menu fills', async () => {
    const { replaceMenu } = await import('../../lib/menu-write');
    const primary = (await menus()).find(menu => menu.id === 'primary')!;
    await replaceMenu({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID }, 'primary', { ...primary, items: [...primary.items, { id: 'x', type: 'url', href: '/x', label: 'X' }] }, { updatedBy: 'test' });
    helper.menus = [{ id: 3, name: 'Main', slug: 'main', locations: ['primary'], items: [] }];
    const { logs, state } = await runStep();
    expect(state.menus_imported).toEqual([{ menu_id: 'wp-main', source_id: 3, locations: [], items: 0 }]);
    expect((await menus()).find(menu => menu.id === 'primary')?.locations).toEqual(['primary']);
    expect(logs.some(line => line.includes('already filled by "Main menu"'))).toBe(true);
  });

  it('continues the migration when menus cannot be read', async () => {
    helper.fail = true;
    const { logs, state } = await runStep();
    expect(state.menus_imported).toEqual([]);
    expect(logs[0]).toMatch(/could not be read/);
    expect((await menus()).every(menu => isStarterMenu(menu))).toBe(true);
  });
});
