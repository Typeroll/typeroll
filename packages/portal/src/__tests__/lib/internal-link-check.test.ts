import { beforeEach, describe, expect, it } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'org';
const SITE = 'site';

describe('checkInternalLinks', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
      name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
    });
  });

  it('resolves page, collection, facet and redirect routes and reports source pairs', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID), {
      title: 'Home', slug: 'home', status: 'published', content_mode: 'html',
      html_content: '<a href="/posts/hello">post</a><a href="/old">old</a><a href="/missing">bad</a>',
    });
    await store.setDoc(paths.partial(ORG, SITE, 'footer', MAIN_VERSION_ID), {
      name: 'Footer', kind: 'footer', status: 'published', content_mode: 'html',
      html_content: '<a href="https://example.com/missing-too">bad</a>',
    });
    await store.setDoc(paths.collection(ORG, SITE, 'posts', MAIN_VERSION_ID), {
      name: 'posts', label_singular: 'Post', label_plural: 'Posts',
      fields: [
        { name: 'slug', label: 'Slug', type: 'text' },
        { name: 'related_url', label: 'Related URL', type: 'url' },
      ],
      route_template: '/posts/{slug}', created_at: new Date().toISOString(),
      item_template_html: '<a href="{{related_url}}">related</a>',
    });
    await store.setDoc(paths.collectionItem(ORG, SITE, 'posts', 'one', MAIN_VERSION_ID), {
      slug: 'hello', related_url: '../missing-related', status: 'published',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await store.setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/old`, {
      from_path: '/old', to_path: '/posts/hello', status_code: 301,
    });

    const { checkInternalLinks } = await import('../../lib/internal-link-check');
    const report = await checkInternalLinks({
      store, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID,
      site: {
        id: SITE, name: 'Site', domain: 'example.com', domain_status: 'live',
        hosting_adapter: 'cloudflare', created_at: new Date().toISOString(),
      },
    });
    expect(report.redirected_links).toBe(1);
    expect(report.broken.map((entry) => [entry.from, entry.href])).toEqual([
      ['page:home', '/missing'],
      ['partial:footer', 'https://example.com/missing-too'],
      ['item:posts/one', '../missing-related'],
    ]);
  });
});
