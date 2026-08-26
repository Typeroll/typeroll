// Tests for analyzeCoverage — the function that classifies every URL in
// the migration inventory as migrated / redirected / excluded / unhandled.
//
// The "migrated" path used to require a target *page* with a matching
// slug or old_wp_url. After the migration refactor (docs/page-slug-audit.md
// follow-up), posts are imported as items in a `posts` collection rather
// than as flat pages with slash-slugs — so analyzeCoverage now also has
// to recognise collection items that materialise URLs via route_template.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type {
  CollectionDef,
  MigrationUrl,
  Page,
  Site,
  SiteVersion,
} from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
}

async function seedInventory(entries: Array<Partial<MigrationUrl> & { path: string }>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  for (const e of entries) {
    await getStore().setDoc(
      `${paths.migrationUrls(ORG, SITE)}/${e.path.replace(/[^a-z0-9-]/gi, '_')}`,
      { full_url: `https://old.example.com${e.path}`, source: 'sitemap', ...e },
    );
  }
}

async function seedPage(id: string, doc: Partial<Page>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: '',
    ...doc,
  });
}

async function seedCollection(def: Partial<CollectionDef> & { name: string }): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  // Defaults first, caller's `def` last so explicit fields override.
  await getStore().setDoc(paths.collection(ORG, SITE, def.name), {
    label_singular: def.name,
    label_plural: def.name,
    slug_field: 'slug',
    fields: [{ name: 'slug', type: 'text', label: 'slug', required: true }],
    created_at: new Date().toISOString(),
    ...def,
  } satisfies Partial<CollectionDef>);
}

async function seedItem(collection: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(
    paths.collectionItem(ORG, SITE, collection, id, MAIN_VERSION_ID),
    {
      status: 'published',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...fields,
    },
  );
}

describe('analyzeCoverage', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('classifies a URL covered by a published page as migrated', async () => {
    await setup();
    await seedInventory([{ path: '/about' }]);
    await seedPage('about', { slug: 'about' });
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('migrated');
    expect(urls[0]?.target).toBe('/about');
    expect(summary.migrated).toBe(1);
  });

  it('classifies a URL covered by a published collection item via route_template as migrated', async () => {
    await setup();
    await seedInventory([{ path: '/blog/hello-world' }]);
    await seedCollection({
      name: 'posts',
      route_template: '/blog/{slug}',
      fields: [{ name: 'slug', type: 'text', label: 'slug', required: true }],
    });
    await seedItem('posts', 'hello-world', { slug: 'hello-world' });
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('migrated');
    expect(urls[0]?.target).toBe('/blog/hello-world');
    expect(summary.migrated).toBe(1);
    expect(summary.unhandled).toBe(0);
  });

  it('matches a collection item via its old_wp_url field when the path differs from the new URL', async () => {
    await setup();
    // Old site had /2024/01/hello, new site exposes /blog/hello.
    await seedInventory([{ path: '/2024/01/hello' }]);
    await seedCollection({
      name: 'posts',
      route_template: '/blog/{slug}',
      fields: [{ name: 'slug', type: 'text', label: 'slug', required: true }],
    });
    await seedItem('posts', 'hello', {
      slug: 'hello',
      old_wp_url: 'https://old.example.com/2024/01/hello',
    });
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('migrated');
    // Target is the *new* URL the item lives at — that's where redirects
    // should point.
    expect(urls[0]?.target).toBe('/blog/hello');
    expect(summary.migrated).toBe(1);
  });

  it('does not count draft collection items', async () => {
    await setup();
    await seedInventory([{ path: '/blog/draft-post' }]);
    await seedCollection({ name: 'posts', route_template: '/blog/{slug}' });
    await seedItem('posts', 'draft-post', { slug: 'draft-post', status: 'draft' });
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('unhandled');
    expect(summary.unhandled).toBe(1);
    expect(summary.migrated).toBe(0);
  });

  it('skips collections with empty route_template (listing-only collections)', async () => {
    await setup();
    await seedInventory([{ path: '/team/anna' }]);
    await seedCollection({
      name: 'team',
      route_template: '',
      fields: [{ name: 'slug', type: 'text', label: 'slug', required: true }],
    });
    await seedItem('team', 'anna', { slug: 'anna' });
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('unhandled');
    expect(summary.unhandled).toBe(1);
  });

  it('classifies a URL with a matching redirect rule as redirected', async () => {
    await setup();
    await seedInventory([{ path: '/old-services' }]);
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(
      `${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/r1`,
      { from_path: '/old-services', to_path: '/services', status: 301 },
    );
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('redirected');
    expect(urls[0]?.target).toBe('/services');
    expect(summary.redirected).toBe(1);
  });

  it('honours the excluded flag on inventory entries', async () => {
    await setup();
    await seedInventory([{ path: '/wp-admin/edit.php', excluded: true }]);
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(summary.excluded).toBe(1);
  });

  it('falls through to unhandled when no source covers a URL', async () => {
    await setup();
    await seedInventory([{ path: '/orphan' }]);
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('unhandled');
    expect(summary.unhandled).toBe(1);
  });

  it('prefers page matches over collection-item matches when both could apply', async () => {
    await setup();
    await seedInventory([{ path: '/blog/news' }]);
    // A page and a collection item both claim this URL — pages win
    // (consistent with the renderer's "pages always shadow items"
    // collision rule documented elsewhere).
    await seedPage('blog-news', { slug: 'blog/news' });
    await seedCollection({ name: 'posts', route_template: '/blog/{slug}' });
    await seedItem('posts', 'news', { slug: 'news' });
    const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    const { urls } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0]?.status).toBe('migrated');
    // Target is the page slug, not the collection item URL.
    expect(urls[0]?.target).toBe('/blog/news');
  });
});
