import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

// Verifies the copy-on-write invariants of vstore: chain reads see the base
// version when a branch hasn't overridden, branch writes don't leak to main,
// tombstones hide base entries on the branch.

const ORG = 'testorg';
const SITE = 'mysite';
const BRANCH = 'feature';

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { vstore } = await import('../../lib/version-store');
  const store = getStore();
  // Materialize a Main version doc + base content.
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main',
    kind: 'main',
    created_at: new Date().toISOString(),
    robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    title: 'Main Home',
    slug: 'home',
    content_mode: 'html',
    status: 'published',
    html_content: '<h1>Main</h1>',
  });
  // Create the branch SiteVersion doc.
  await store.setDoc(paths.version(ORG, SITE, BRANCH), {
    name: 'Feature',
    kind: 'branch',
    base_version_id: MAIN_VERSION_ID,
    created_at: new Date().toISOString(),
    robots_blocked: true,
  } satisfies Partial<SiteVersion>);
  return { store, vstore };
}

describe('vstore chain reads', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('returns main doc when branch has no override', async () => {
    const { vstore } = await setup();
    const page = await vstore.page(ORG, SITE, BRANCH, 'home');
    expect(page?.title).toBe('Main Home');
  });

  it('branch override shadows main', async () => {
    const { vstore } = await setup();
    await vstore.writePage(ORG, SITE, BRANCH, 'home', {
      title: 'Branch Home',
      slug: 'home',
      content_mode: 'html',
      status: 'published',
      html_content: '<h1>Branch</h1>',
    });
    const onBranch = await vstore.page(ORG, SITE, BRANCH, 'home');
    expect(onBranch?.title).toBe('Branch Home');
    // Main is untouched.
    const onMain = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(onMain?.title).toBe('Main Home');
  });

  it('tombstone hides a main-only page on the branch', async () => {
    const { vstore } = await setup();
    await vstore.deletePage(ORG, SITE, BRANCH, 'home');
    const onBranch = await vstore.page(ORG, SITE, BRANCH, 'home');
    expect(onBranch).toBeNull();
    const onMain = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(onMain?.title).toBe('Main Home');
  });

  it('list returns the merged view (branch overrides win, tombstones hide)', async () => {
    const { store, vstore } = await setup();
    // Add two more docs on main.
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`, {
      title: 'About', slug: 'about', content_mode: 'html', status: 'published',
    });
    await store.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/contact`, {
      title: 'Contact', slug: 'contact', content_mode: 'html', status: 'published',
    });
    // Branch overrides "about" and tombstones "contact".
    await vstore.writePage(ORG, SITE, BRANCH, 'about', {
      title: 'About (Branch)', slug: 'about', content_mode: 'html', status: 'published',
    });
    await vstore.deletePage(ORG, SITE, BRANCH, 'contact');

    const list = await vstore.pages(ORG, SITE, BRANCH);
    const titles = list.map((p) => p.title).sort();
    expect(titles).toEqual(['About (Branch)', 'Main Home']);
  });

  it('inherits, forks, and tombstones block-type dependencies', async () => {
    const { store, vstore } = await setup();
    await store.setDoc(paths.blockType(ORG, SITE, 'lead-form', MAIN_VERSION_ID), {
      id: 'lead-form', name: 'lead-form', label: 'Lead form', category: 'custom',
      container: false, schema: [], template: '<div>main</div>', origin: 'third_party',
      created_at: new Date().toISOString(),
    });
    expect((await vstore.blockTypes(ORG, SITE, BRANCH)).map((type) => type.id)).toContain('lead-form');
    await vstore.writeBlockType(ORG, SITE, BRANCH, 'lead-form', { template: '<div>branch</div>' });
    expect((await vstore.blockType(ORG, SITE, BRANCH, 'lead-form'))?.template).toContain('branch');
    expect((await vstore.blockType(ORG, SITE, MAIN_VERSION_ID, 'lead-form'))?.template).toContain('main');
    await vstore.deleteBlockType(ORG, SITE, BRANCH, 'lead-form');
    expect(await vstore.blockType(ORG, SITE, BRANCH, 'lead-form')).toBeNull();
    expect(await vstore.blockType(ORG, SITE, MAIN_VERSION_ID, 'lead-form')).not.toBeNull();
  });

  it('inherits page-template dependencies from the base version', async () => {
    const { store, vstore } = await setup();
    await store.setDoc(paths.pageTemplate(ORG, SITE, 'article', MAIN_VERSION_ID), {
      id: 'article', name: 'article', label: 'Article', status: 'active',
      blocks: [{ id: 'slot', type: 'template/content_slot', data: {} }],
      created_at: new Date().toISOString(),
    });
    const template = await vstore.pageTemplate(ORG, SITE, BRANCH, 'article');
    expect(template?.id).toBe('article');
    expect(template?.blocks[0]?.type).toBe('template/content_slot');
  });

  it('inherits, forks, guards and tombstones menus', async () => {
    const { store, vstore } = await setup();
    const { MenuWriteConflict } = await import('../../lib/version-store');
    const main = { id: 'main-menu', name: 'Main', locations: ['primary'], items: [{ id: 'home', type: 'page' as const, page_id: 'home' }] };
    await vstore.writeMenu(ORG, SITE, MAIN_VERSION_ID, main, null);
    expect((await store.getDoc<{ name: string }>(paths.menu(ORG, SITE, 'main-menu', MAIN_VERSION_ID)))?.name).toBe('Main');
    expect((await vstore.menus(ORG, SITE, BRANCH)).map((menu) => menu.id)).toEqual(['main-menu']);

    const read = (await vstore.menu(ORG, SITE, BRANCH, 'main-menu'))!;
    await vstore.writeMenu(ORG, SITE, BRANCH, { ...main, name: 'Branch' }, read);
    expect((await vstore.menu(ORG, SITE, BRANCH, 'main-menu'))?.name).toBe('Branch');
    expect((await vstore.menu(ORG, SITE, MAIN_VERSION_ID, 'main-menu'))?.name).toBe('Main');
    // A save based on what the branch showed before is refused.
    await expect(vstore.writeMenu(ORG, SITE, BRANCH, { ...main, name: 'Stale' }, read)).rejects.toBeInstanceOf(MenuWriteConflict);
    await expect(vstore.writeMenu(ORG, SITE, MAIN_VERSION_ID, main, null)).rejects.toBeInstanceOf(MenuWriteConflict);

    await vstore.deleteMenu(ORG, SITE, BRANCH, 'main-menu');
    expect(await vstore.menu(ORG, SITE, BRANCH, 'main-menu')).toBeNull();
    expect(await vstore.menus(ORG, SITE, BRANCH)).toEqual([]);
    expect(await vstore.menu(ORG, SITE, MAIN_VERSION_ID, 'main-menu')).not.toBeNull();
    // Writing again on the branch lifts the tombstone.
    await vstore.writeMenu(ORG, SITE, BRANCH, { ...main, name: 'Again' });
    expect((await vstore.menu(ORG, SITE, BRANCH, 'main-menu'))?.name).toBe('Again');
  });

  it('inherits, forks and guards the site fields', async () => {
    const { store, vstore } = await setup();
    const { SiteFieldsWriteConflict } = await import('../../lib/version-store');
    expect(await vstore.siteFields(ORG, SITE, BRANCH)).toEqual({ groups: [], values: {} });
    const groups = [{ id: 'booking', label: 'Booking', access: 'editor' as const, fields: [{ name: 'show_booking', type: 'boolean' as const, label: 'Show' }] }];
    await vstore.writeSiteFields(ORG, SITE, MAIN_VERSION_ID, { groups, values: { show_booking: true }, updated_at: 'T1' }, null);
    expect(await store.getDoc(paths.siteFields(ORG, SITE, MAIN_VERSION_ID))).toMatchObject({ values: { show_booking: true } });
    expect(await vstore.siteFields(ORG, SITE, BRANCH)).toEqual({ groups, values: { show_booking: true }, updated_at: 'T1' });

    await vstore.writeSiteFields(ORG, SITE, BRANCH, { groups, values: { show_booking: false }, updated_at: 'T2' }, 'T1');
    expect((await vstore.siteFields(ORG, SITE, BRANCH)).values).toEqual({ show_booking: false });
    expect((await vstore.siteFields(ORG, SITE, MAIN_VERSION_ID)).values).toEqual({ show_booking: true });
    // A save based on what the branch showed before is refused.
    await expect(vstore.writeSiteFields(ORG, SITE, BRANCH, { groups, values: {}, updated_at: 'T3' }, 'T1')).rejects.toBeInstanceOf(SiteFieldsWriteConflict);
    await expect(vstore.writeSiteFields(ORG, SITE, MAIN_VERSION_ID, { groups, values: {} }, null)).rejects.toBeInstanceOf(SiteFieldsWriteConflict);
  });

  // Regression: Firestore rejects doc paths with an odd number of segments.
  // Tombstone paths previously used `_tombstones/{kind}/{id}` which produces
  // 9 segments under a version doc — 500-ing every chain read on prod.
  // The fix collapses kind into the collection name (`_tombstones_{kind}/{id}`)
  // so the doc path is 8 segments / even.
  it('tombstone doc paths have an even number of segments', async () => {
    const { store, vstore } = await setup();
    await vstore.deletePage(ORG, SITE, BRANCH, 'home');
    // Tombstones land at `_tombstones_{kind}/{id}`. The full collection path
    // has 7 segments (odd → collection); each tombstone doc inside has 8
    // (even → doc). If we ever revert to `_tombstones/{kind}/{id}` the doc
    // path becomes 9 and Firestore 500s on every chain read.
    const tombstoneColl = `organizations/${ORG}/sites/${SITE}/versions/${BRANCH}/_tombstones_pages`;
    expect(tombstoneColl.split('/').length % 2).toBe(1);
    const tombs = await store.listDocs(tombstoneColl);
    expect(tombs.length).toBe(1);
    expect(tombs[0].id).toBe('home');
  });
});
