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
    await store.setDoc(paths.contentType(ORG, SITE, 'posts', MAIN_VERSION_ID), {
      name: 'posts', label_singular: 'Post', label_plural: 'Posts',
      fields: [
        { name: 'related_url', label: 'Related URL', type: 'url' },
      ],
      route_template: '/posts/{slug}', created_at: new Date().toISOString(),
    });
    await store.setDoc(paths.page(ORG, SITE, 'one', MAIN_VERSION_ID), {
      content_type: 'posts', title: 'Hello', slug: 'hello', fields: { related_url: '../missing-related' }, status: 'published',
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
      ['page:one', '../missing-related'],
      ['partial:footer', 'https://example.com/missing-too'],
    ]);
  });

  it('checks menu items: page ids, unpublished pages and addresses', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.page(ORG, SITE, 'about', MAIN_VERSION_ID), { title: 'About', slug: 'about', status: 'published', content_mode: 'html', html_content: '' });
    await store.setDoc(paths.page(ORG, SITE, 'team', MAIN_VERSION_ID), { title: 'Team', slug: 'team', parent: 'about', status: 'published', content_mode: 'html', html_content: '' });
    await store.setDoc(paths.page(ORG, SITE, 'wip', MAIN_VERSION_ID), { title: 'WIP', slug: 'wip', status: 'draft', content_mode: 'html', html_content: '' });
    await store.setDoc(paths.menu(ORG, SITE, 'main', MAIN_VERSION_ID), {
      name: 'Main', items: [
        { id: 'a', type: 'children', page_id: 'about', label: 'About' },
        { id: 'b', type: 'page', page_id: 'gone' },
        { id: 'c', type: 'url', href: '/nowhere/', label: 'Nowhere', children: [{ id: 'd', type: 'page', page_id: 'wip' }] },
      ],
    });
    const { checkInternalLinks } = await import('../../lib/internal-link-check');
    const report = await checkInternalLinks({
      store, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, includeLinks: true,
      site: { id: SITE, name: 'Site', hosting_adapter: 'cloudflare', created_at: new Date().toISOString() },
    });
    expect(report.broken.filter(entry => entry.from === 'menu:main').map(entry => [entry.href, entry.reason])).toEqual([
      ['/nowhere/', 'missing_route'], ['page:gone', 'missing_page'],
    ]);
    expect(report.unpublished_targets).toEqual([expect.objectContaining({ from: 'menu:main', page_id: 'wip' })]);
    expect(report.links?.filter(link => link.from === 'menu:main').map(link => link.path).sort()).toEqual(['/about', '/team']);
  });

  it('reports #fragments that no element on the target Page carries', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    // An imported table of contents whose heading ids were not carried over.
    const toc = Array.from({ length: 12 }, (_, index) => `<a href="#wp-section-${index + 1}">Section ${index + 1}</a>`).join('');
    await store.setDoc(paths.page(ORG, SITE, 'guide', MAIN_VERSION_ID), {
      title: 'Guide', slug: 'guide', status: 'published', content_mode: 'html',
      html_content: `<nav>${toc}</nav><a href="#">top</a><a href="#top">top</a><a href="#kept">kept</a><a href="#cookie-settings">cookies</a>`
        + '<a href="#waarom-verhuizen">generated</a><a href="#caf%C3%A9">encoded</a><a href="#legacy">legacy</a><a href="#site-footer">footer</a>'
        + '<h2 id="kept">Kept</h2><h2>Waarom verhuizen?</h2><p id="café">Café</p><a name="legacy"></a>',
    });
    await store.setDoc(paths.page(ORG, SITE, 'blocks', MAIN_VERSION_ID), {
      title: 'Blocks', slug: 'blocks', status: 'published', content_mode: 'blocks', blocks: [
        { id: 'h1', type: 'core/heading', data: { text: 'Kosten & planning', level: 'h2' } },
        { id: 'h2', type: 'core/heading', data: { text: 'Custom', level: 'h3', anchor_id: 'custom-anchor' } },
        { id: 'p1', type: 'core/prose', data: { html: '<p>Body</p>' }, style_overrides: { html_id: 'intro' } },
      ],
    });
    await store.setDoc(paths.page(ORG, SITE, 'links', MAIN_VERSION_ID), {
      title: 'Links', slug: 'links', status: 'published', content_mode: 'html',
      html_content: '<a href="/blocks#kosten-planning">a</a><a href="/blocks/#custom-anchor">b</a><a href="/blocks?x=1#intro">c</a>'
        + '<a href="/blocks#gone">d</a><a href="/old-blocks#intro">e</a><a href="/old-blocks#nope">f</a><a href="/guide#kept">g</a>'
        // `#cookie-settings` opens the cookie banner on any Page.
        + '<a href="/guide#cookie-settings">h</a>',
    });
    await store.setDoc(paths.partial(ORG, SITE, 'footer', MAIN_VERSION_ID), {
      name: 'Footer', kind: 'footer', status: 'published', content_mode: 'html',
      html_content: '<footer id="site-footer"><a href="#anything">skipped</a><a href="/guide#missing-from-footer">x</a></footer>',
    });
    await store.setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/old-blocks`, {
      from_path: '/old-blocks', to_path: '/blocks', status_code: 301,
    });

    const { checkInternalLinks } = await import('../../lib/internal-link-check');
    const site = { id: SITE, name: 'Site', hosting_adapter: 'cloudflare' as const, created_at: new Date().toISOString() };
    const report = await checkInternalLinks({ store, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, site });
    const fragments = report.broken.filter(entry => entry.reason === 'missing_fragment');
    expect(fragments.filter(entry => entry.from === 'page:guide')).toEqual([
      ...Array.from({ length: 12 }, (_, index) => ({
        from: 'page:guide', href: `#wp-section-${index + 1}`, resolved_path: '/guide', reason: 'missing_fragment', fragment: `wp-section-${index + 1}`,
      })),
      // The sanitizer drops `<a name>`, so a published page has no such anchor.
      { from: 'page:guide', href: '#legacy', resolved_path: '/guide', reason: 'missing_fragment', fragment: 'legacy' },
    ]);
    expect(fragments.filter(entry => entry.from !== 'page:guide').map(entry => [entry.from, entry.href, entry.resolved_path])).toEqual([
      ['page:links', '/blocks#gone', '/blocks'],
      ['page:links', '/old-blocks#nope', '/blocks'],
      ['partial:footer', '/guide#missing-from-footer', '/guide'],
    ]);
    expect(report.broken.filter(entry => entry.reason !== 'missing_fragment')).toEqual([]);

    const plain = await checkInternalLinks({ store, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, site, fragments: false });
    expect(plain.broken).toEqual([]);
  });
});
