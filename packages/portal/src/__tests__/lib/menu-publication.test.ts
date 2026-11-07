// Site menus in previews and publications (render version 15): the preview
// renders a menu-sourced Navigation links block from the version's menus, the
// export check refuses a menu that no longer validates, and the publication
// lists missing menus, shared locations and items whose page is gone.
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Block, Menu, Site, SiteVersion } from '@typeroll/shared';
import { assertContentExportable, publicationMenuWarnings } from '../../lib/publishing/content-preflight';

const ORG = 'orgone';
const SITE = 'mysite';
const MENU: Menu = { id: 'main', name: 'Main', locations: ['primary'], items: [
  { id: 'home', type: 'page', page_id: 'home' },
  { id: 'gone', type: 'page', page_id: 'gone' },
  { id: 'more', type: 'heading', label: 'More', children: [{ id: 'blog', type: 'url', href: '/blog/', label: 'Blog' }] },
] };
const nav = (menu = 'location:primary'): Block => ({ id: 'nav', type: 'core/navigation_links', data: { source: 'menu', menu, direction: 'row' } });
const empty = { pages: [], partials: [], pageTemplates: [], blockTypes: [], contentTypes: [] };

describe('menus in the preview', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), { name: 'Menu Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
    await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false } satisfies Partial<SiteVersion>);
    await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), { site_name: 'Menu Site', render_version: 15 });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, { title: 'Start', slug: 'home', path: '/', content_mode: 'blocks', status: 'published', blocks: [nav()], html_content: '' });
    const { id: _id, ...menu } = MENU;
    await store.setDoc(paths.menu(ORG, SITE, 'main', MAIN_VERSION_ID), menu);
  });

  it('renders the version\'s menu with the current page and the submenu', async () => {
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
    expect(html).toContain('<a href="/" aria-current="page">Start</a>');
    expect(html).toContain('class="block-nav-toggle block-nav-toggle--label" aria-expanded="false" aria-controls="nav-nav-more">More</button>');
    expect(html).toContain('<a href="/blog/">Blog</a>');
  });

  it('keeps an older render version on the block\'s own links', async () => {
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, { renderVersion: 14 }))!;
    expect(html).not.toContain('aria-controls="nav-nav-more"');
  });
});

describe('menus in a publication', () => {
  it('refuses a menu that no longer validates', () => {
    expect(() => assertContentExportable({ ...empty, menus: [{ ...MENU, items: [{ id: 'x', type: 'url', href: 'javascript:alert(1)', label: 'X' }] }] }))
      .toThrow(/menus\/main\.items\[0\]\.href/);
    expect(() => assertContentExportable({ ...empty, menus: [MENU] })).not.toThrow();
  });

  it('warns about missing menus, shared locations and items whose page is gone', () => {
    const publication = {
      settings: { render_version: 15 },
      pages: [{ id: 'home', title: 'Start', path: '/', status: 'published', blocks: [nav('location:footer')] }],
      partials: [{ id: 'header', kind: 'header', blocks: [nav()] }],
      menus: [MENU, { id: 'other', name: 'Other', locations: ['primary'], items: [] }],
    };
    expect(publicationMenuWarnings(publication)).toEqual([
      'More than one menu fills the location "primary"; Navigation links blocks show the first.',
      'page home shows the menu "location:footer", which does not exist; the block renders no links.',
      'Menu "Main": item gone links to a page that is missing or not published; it is left out.',
    ]);
    expect(publicationMenuWarnings({ ...publication, settings: { render_version: 14 }, menus: [MENU] })).toEqual([
      'Navigation links blocks that show a site menu render their own links until the site uses render version 15 (first in page home).',
    ]);
    expect(publicationMenuWarnings({ pages: [], partials: [], menus: [MENU] })).toEqual([]);
  });
});
