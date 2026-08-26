// regenerate_collection_listing — marker-delimited section swap with
// template-rendered item HTML.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { CollectionDef, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

async function seedCollection(name: string, def: Partial<CollectionDef> = {}): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.collection(ORG, SITE, name, MAIN_VERSION_ID), {
    name,
    label_singular: name,
    label_plural: `${name}s`,
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'slug', label: 'Slug', type: 'text' },
    ],
    route_template: `/${name}/{slug}`,
    sort_field: 'title',
    sort_dir: 'asc',
    ...def,
  });
}

async function seedItem(name: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.collectionItem(ORG, SITE, name, id, MAIN_VERSION_ID), {
    status: 'published', created_at: '2026-01-01', updated_at: '2026-01-01', ...fields,
  });
}

async function seedPage(id: string, htmlContent: string): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: htmlContent,
  });
}

interface CallInit { headers?: HeadersInit; body?: unknown }
async function callRoute(
  routeImport: Promise<Partial<Record<'POST', APIRoute>>>,
  method: 'POST',
  url: string,
  params: Record<string, string>,
  init?: CallInit,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string' ? JSON.stringify(init.body) : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

describe('regenerate_collection_listing', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('replaces the marker section with default-template <li>s', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    await seedItem('blog', 'i1', { title: 'Beta launch', slug: 'beta-launch' });
    await seedItem('blog', 'i2', { title: 'Alpha launch', slug: 'alpha-launch' });
    await seedPage('home', `<h1>Welcome</h1>
<!-- typeroll:listing:blog -->
old content here
<!-- /typeroll:listing:blog -->
<footer>end</footer>`);

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/regenerate-listing'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/regenerate-listing`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { page_id: 'home' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { items_rendered: number; page: { html_content: string } };
    expect(body.items_rendered).toBe(2);
    // Sorted asc by title → Alpha first, Beta second
    const html = body.page.html_content;
    expect(html).toContain('<h1>Welcome</h1>');
    expect(html).toContain('Alpha launch');
    expect(html).toContain('Beta launch');
    expect(html.indexOf('Alpha launch')).toBeLessThan(html.indexOf('Beta launch'));
    expect(html).toContain('<a href="/blog/alpha-launch">');
    expect(html).toContain('<footer>end</footer>');
    // Old content is gone
    expect(html).not.toContain('old content here');
  });

  it('returns 400 with marker instructions when markers are missing', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    await seedPage('home', '<h1>No markers here</h1>');
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/regenerate-listing'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/regenerate-listing`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { page_id: 'home' } },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('<!-- typeroll:listing:blog -->');
  });

  it('renders the empty_html when no published items exist', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    await seedItem('blog', 'i1', { title: 'Draft post', slug: 'draft', status: 'draft' });
    await seedPage('home', '<!-- typeroll:listing:blog --><!-- /typeroll:listing:blog -->');
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/regenerate-listing'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/regenerate-listing`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { page_id: 'home', empty_html: '<p>None yet, check back!</p>' } },
    );
    const body = await res.json() as { items_rendered: number; page: { html_content: string } };
    expect(body.items_rendered).toBe(0);
    expect(body.page.html_content).toContain('None yet, check back!');
  });

  it('respects a custom item_template with field substitutions + URL', async () => {
    const { token } = await setup();
    await seedCollection('events');
    await seedItem('events', 'a', { title: 'Spring meetup', slug: 'spring', location: 'Stockholm' });
    await seedPage('home', '<!-- typeroll:listing:events --><!-- /typeroll:listing:events -->');

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/regenerate-listing'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/events/regenerate-listing`,
      { siteId: SITE, name: 'events' },
      {
        headers: bearer(token),
        body: {
          page_id: 'home',
          item_template: '<article><h3><a href="{{url}}">{{title}}</a></h3><span>{{location}}</span></article>',
          wrap_open: '<section class="events-grid">',
          wrap_close: '</section>',
        },
      },
    );
    const body = await res.json() as { page: { html_content: string } };
    expect(body.page.html_content).toContain('<section class="events-grid">');
    expect(body.page.html_content).toContain('<a href="/events/spring">Spring meetup</a>');
    expect(body.page.html_content).toContain('<span>Stockholm</span>');
  });

  it('escapes HTML in {{field}} but not in {{{field}}}', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    await seedItem('blog', 'a', {
      title: 'A <b>bold</b> post', slug: 'bold',
      excerpt: '<p>Pre-rendered excerpt with <em>html</em>.</p>',
    });
    await seedPage('home', '<!-- typeroll:listing:blog --><!-- /typeroll:listing:blog -->');

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/regenerate-listing'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/regenerate-listing`,
      { siteId: SITE, name: 'blog' },
      {
        headers: bearer(token),
        body: {
          page_id: 'home',
          item_template: '<article><h3>{{title}}</h3>{{{excerpt}}}</article>',
        },
      },
    );
    const body = await res.json() as { page: { html_content: string } };
    // Title is escaped — <b> shows as &lt;b&gt;
    expect(body.page.html_content).toContain('A &lt;b&gt;bold&lt;/b&gt; post');
    // Excerpt's HTML is preserved
    expect(body.page.html_content).toContain('<p>Pre-rendered excerpt with <em>html</em>.</p>');
  });

  it('honors sort_field + sort_dir override', async () => {
    const { token } = await setup();
    await seedCollection('blog');
    await seedItem('blog', 'i1', { title: 'A post', slug: 'a', published_at: '2026-03-01' });
    await seedItem('blog', 'i2', { title: 'B post', slug: 'b', published_at: '2026-01-01' });
    await seedPage('home', '<!-- typeroll:listing:blog --><!-- /typeroll:listing:blog -->');

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/regenerate-listing'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/blog/regenerate-listing`,
      { siteId: SITE, name: 'blog' },
      { headers: bearer(token), body: { page_id: 'home', sort_field: 'published_at', sort_dir: 'desc' } },
    );
    const body = await res.json() as { page: { html_content: string } };
    // March 2026 > January 2026 → "A post" comes first under desc
    const html = body.page.html_content;
    expect(html.indexOf('A post')).toBeLessThan(html.indexOf('B post'));
  });

  // Regression — see feedback_skill_updates.md C3 + tr-directory A3.1.
  // Before this fix, regenerate-listing sorted any field as a string, so
  // numeric episode 9 sorted above 23 (lex). Verifies that a `type: number`
  // field now sorts numerically end-to-end.
  it('sorts a numeric field as numbers, not lex (9 < 23)', async () => {
    const { token } = await setup();
    await seedCollection('podcasts', {
      fields: [
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'slug', label: 'Slug', type: 'text' },
        { name: 'episode', label: 'Episode', type: 'number' },
      ],
      route_template: '/podd/{slug}',
      sort_field: 'episode',
      sort_dir: 'desc',
    });
    await seedItem('podcasts', 'ep-1',  { slug: 'one', title: 'One', episode: 1 });
    await seedItem('podcasts', 'ep-9',  { slug: 'nine', title: 'Nine', episode: 9 });
    await seedItem('podcasts', 'ep-23', { slug: 'twentythree', title: 'Twentythree', episode: 23 });
    await seedPage('home',
      '<h1>All episodes</h1><!-- typeroll:listing:podcasts --><!-- /typeroll:listing:podcasts -->'
    );
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/collections/[name]/regenerate-listing'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/collections/podcasts/regenerate-listing`,
      { siteId: SITE, name: 'podcasts' },
      { headers: bearer(token), body: {
        page_id: 'home',
        item_template: '<li>{{episode}}: {{title}}</li>',
      } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { page: { html_content: string } };
    const html = body.page.html_content;
    // Descending: 23, 9, 1
    expect(html.indexOf('23:')).toBeLessThan(html.indexOf('9:'));
    expect(html.indexOf('9:')).toBeLessThan(html.indexOf('1:'));
  });
});
