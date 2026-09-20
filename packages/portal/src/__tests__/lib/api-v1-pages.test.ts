// End-to-end-ish tests for the /v1/sites + /v1/sites/{siteId}/pages route
// handlers. We call the route exports directly with hand-built Request
// objects (no HTTP server), so what we exercise is the full middleware +
// handler stack minus Astro's URL → handler dispatch.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

interface Setup {
  token: string;
}

async function setup(): Promise<Setup> {
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
  const { token } = await createApiKey({
    orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com',
  });
  return { token };
}

async function seedPage(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: '<p>seed</p>',
    ...doc,
  });
}

interface CallInit {
  headers?: HeadersInit;
  /** Either an already-stringified body or any JSON-serializable value. */
  body?: unknown;
}

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: CallInit,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string'
    ? JSON.stringify(init.body)
    : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/v1/sites', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns the one site the key can access', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/index'),
      'GET',
      'http://localhost/api/v1/sites',
      {},
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { sites: Array<{ id: string }> };
    expect(body.sites.map((s) => s.id)).toEqual([SITE]);
  });

  it('401 without a token', async () => {
    await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/index'),
      'GET',
      'http://localhost/api/v1/sites', {},
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/sites/{siteId}', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns site metadata', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; name: string };
    expect(body.id).toBe(SITE);
    expect(body.name).toBe('My Site');
  });
});

describe('GET /api/v1/sites/{siteId}/pages', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('lists pages, filters by status, paginates with a cursor', async () => {
    const { token } = await setup();
    await seedPage('a', { title: 'A', status: 'published' });
    await seedPage('b', { title: 'B', status: 'draft' });
    await seedPage('c', { title: 'C', status: 'published' });

    // List with no filter — all three.
    const allRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const all = await allRes.json() as { pages: Array<{ id: string }> };
    expect(all.pages.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);

    // Filter to drafts.
    const draftRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages?status=draft`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const drafts = await draftRes.json() as { pages: Array<{ id: string }> };
    expect(drafts.pages.map((p) => p.id)).toEqual(['b']);

    // Paginate with limit=1, follow the cursor.
    const p1Res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages?limit=1`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const p1 = await p1Res.json() as { pages: Array<{ id: string }>; next_cursor: string | null };
    expect(p1.pages.length).toBe(1);
    expect(p1.next_cursor).toBeTruthy();
    const p2Res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages?limit=1&cursor=${encodeURIComponent(p1.next_cursor!)}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const p2 = await p2Res.json() as { pages: Array<{ id: string }> };
    expect(p2.pages.length).toBe(1);
    expect(p2.pages[0].id).not.toBe(p1.pages[0].id);
  });
});

describe('POST /api/v1/sites/{siteId}/pages', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('creates a page with a unique slug + status defaulting to draft', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'New About', html_content: '<h1>hi</h1>' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { id: string; slug: string; status: string } };
    expect(body.page.slug).toBe('new-about');
    expect(body.page.status).toBe('draft');

    const { vstore } = await import('../../lib/version-store');
    const fresh = await vstore.page(ORG, SITE, MAIN_VERSION_ID, body.page.id);
    expect(fresh?.title).toBe('New About');
  });

  it('rejects a slug containing an internal slash and points at the path field (regression — docs/page-slug-audit.md, docs/page-path-plan.md)', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'Sub Path', slug: 'blog/foo', html_content: '<p>hi</p>' } },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    // Must explicitly mention slashes AND point at the `path` field —
    // agents that hit this need to know where to go next. (Pre-C6 the
    // message pointed at collections; now `path` is the right answer
    // for nested URLs.)
    expect(body.error.toLowerCase()).toContain('slash');
    expect(body.error.toLowerCase()).toMatch(/`path`|path field/);

    // No doc must have been created — the validator runs before any
    // write, but we double-check from the store.
    const { vstore } = await import('../../lib/version-store');
    const pages = await vstore.pages(ORG, SITE, MAIN_VERSION_ID);
    expect(pages.length).toBe(0);
  });

  it('strips leading and trailing slashes before validating (regression — docs/page-slug-audit.md)', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'About', slug: '/about/', html_content: '<p>hi</p>' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { slug: string } };
    expect(body.page.slug).toBe('about');
  });

  // C6 — nested URL paths via the `path` field. See docs/page-path-plan.md.
  describe('nested URLs via the `path` field', () => {
    it('creates a page with an explicit nested path, deriving a safe doc id', async () => {
      const { token } = await setup();
      const res = await callRoute(
        import('../../pages/api/v1/sites/[siteId]/pages/index'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/pages`,
        { siteId: SITE },
        { headers: bearer(token), body: {
          title: 'Summer offer',
          slug: 'sommar',
          path: '/erbjudanden/sommar',
          html_content: '<p>Sun!</p>',
        } },
      );
      expect(res.status).toBe(201);
      const body = await res.json() as { page: { id: string; slug: string; path: string; url: string } };
      expect(body.page.slug).toBe('sommar');
      expect(body.page.path).toBe('/erbjudanden/sommar');
      expect(body.page.url).toBe('/erbjudanden/sommar');
      // Doc id translates slashes to underscores so Firestore doesn't read
      // the id as a nested collection.
      expect(body.page.id).toBe('erbjudanden_sommar');
    });

    it('lets two pages share a slug under different paths', async () => {
      const { token } = await setup();
      await callRoute(
        import('../../pages/api/v1/sites/[siteId]/pages/index'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/pages`,
        { siteId: SITE },
        { headers: bearer(token), body: { title: 'Summer offer', slug: 'sommar', path: '/erbjudanden/sommar' } },
      );
      const res = await callRoute(
        import('../../pages/api/v1/sites/[siteId]/pages/index'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/pages`,
        { siteId: SITE },
        { headers: bearer(token), body: { title: 'Summer event', slug: 'sommar', path: '/event/sommar' } },
      );
      expect(res.status).toBe(201);
      const body = await res.json() as { page: { id: string; slug: string; path: string } };
      // Both pages have slug "sommar"; the second one keeps it because
      // its URL differs.
      expect(body.page.slug).toBe('sommar');
      expect(body.page.path).toBe('/event/sommar');
      expect(body.page.id).toBe('event_sommar');
    });

    it('rejects a duplicate explicit URL rather than changing the requested address', async () => {
      const { token } = await setup();
      await callRoute(
        import('../../pages/api/v1/sites/[siteId]/pages/index'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/pages`,
        { siteId: SITE },
        { headers: bearer(token), body: { title: 'First', slug: 'sommar', path: '/erbjudanden/sommar' } },
      );
      const res = await callRoute(
        import('../../pages/api/v1/sites/[siteId]/pages/index'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/pages`,
        { siteId: SITE },
        { headers: bearer(token), body: { title: 'Second', slug: 'sommar', path: '/erbjudanden/sommar' } },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('/erbjudanden/sommar');
    });

    it('rejects malformed paths up-front', async () => {
      const { token } = await setup();
      const bad = ['no-leading-slash', '/Has-Uppercase', '/double//slash', '/has space', '/foo/bar/', '/..', '/../escape'];
      for (const p of bad) {
        const res = await callRoute(
          import('../../pages/api/v1/sites/[siteId]/pages/index'),
          'POST',
          `http://localhost/api/v1/sites/${SITE}/pages`,
          { siteId: SITE },
          { headers: bearer(token), body: { title: 'x', slug: 'x', path: p } },
        );
        expect(res.status, `path="${p}" should have been rejected`).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error.toLowerCase()).toContain('path');
      }
    });

    it('returns the resolved url in the response so callers know the live URL', async () => {
      const { token } = await setup();
      const res = await callRoute(
        import('../../pages/api/v1/sites/[siteId]/pages/index'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/pages`,
        { siteId: SITE },
        { headers: bearer(token), body: { title: 'Plain page', slug: 'about' } },
      );
      expect(res.status).toBe(201);
      const body = await res.json() as { page: { slug: string; path?: string; url: string } };
      expect(body.page.slug).toBe('about');
      // No explicit path → url falls back to "/" + slug, and path stays unset
      // so existing pages stay clean.
      expect(body.page.path).toBeUndefined();
      expect(body.page.url).toBe('/about');
    });
  });

  it('defaults to blocks-mode and seeds with a heading + prose block', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'Blocks default' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { id: string; content_mode: string; blocks?: Array<{ type: string }> } };
    expect(body.page.content_mode).toBe('blocks');
    expect(body.page.blocks?.length).toBe(2);
    expect(body.page.blocks?.[0]?.type).toBe('core/heading');
    expect(body.page.blocks?.[1]?.type).toBe('core/prose');
  });

  it('opts into html-mode when html_content is provided without an explicit content_mode', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'HTML via body', html_content: '<p>hi</p>' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { content_mode: string; html_content?: string } };
    expect(body.page.content_mode).toBe('html');
    expect(body.page.html_content).toBe('<p>hi</p>');
  });

  it('opts into html-mode when content_mode="html" is passed explicitly', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'HTML explicit', content_mode: 'html' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { content_mode: string; html_content?: string } };
    expect(body.page.content_mode).toBe('html');
    expect(body.page.html_content).toContain('<h1>HTML explicit</h1>');
  });

  it('uses blocks-mode when content_mode="blocks" is explicitly passed', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'Blocks explicit', content_mode: 'blocks' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { id: string; content_mode: string; blocks?: unknown[] } };
    expect(body.page.content_mode).toBe('blocks');
    expect(body.page.blocks?.length).toBe(2);
  });

  it('accepts html_content in html-mode create', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'HTML with content', html_content: '<p>hi</p>' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { content_mode: string; html_content: string } };
    expect(body.page.content_mode).toBe('html');
    expect(body.page.html_content).toBe('<p>hi</p>');
  });

  it('accepts an explicit blocks tree at create time', async () => {
    const { token } = await setup();
    const blocks = [
      { id: 'b1', type: 'core/heading', data: { text: 'Custom', level: 'h1' } },
    ];
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'Custom blocks', blocks } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { page: { blocks: Array<{ id: string }> } };
    expect(body.page.blocks).toHaveLength(1);
    expect(body.page.blocks[0].id).toBe('b1');
  });

  it('400 when title is missing', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { html_content: '<p>x</p>' } },
    );
    expect(res.status).toBe(400);
  });
});

describe('GET/PATCH/PUT/DELETE /api/v1/sites/{siteId}/pages/{pageId}', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('round-trips a page through GET → PATCH → GET', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home', html_content: '<h1>old</h1>' });

    const getRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token) },
    );
    const got = await getRes.json() as { page: { title: string; html_content: string } };
    expect(got.page.title).toBe('Home');

    const patchRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { html_content: '<h1>new</h1>' } },
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json() as { page: { html_content: string; title: string } };
    expect(patched.page.html_content).toBe('<h1>new</h1>');
    expect(patched.page.title).toBe('Home'); // untouched
  });

  it('rejects content_mode in PATCH and points callers to the safe mode endpoint', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home', content_mode: 'html' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { content_mode: 'blocks' } },
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('/mode');

    const { vstore } = await import('../../lib/version-store');
    const page = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(page?.content_mode).toBe('html');
  });

  it('rejects inert top-level responsive data in whole-tree PATCH writes', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home', content_mode: 'blocks', blocks: [] });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      {
        headers: bearer(token),
        body: {
          blocks: [{
            id: 'grid', type: 'core/grid', data: { cols: 3 },
            responsive: { mobile: { data_overrides: { cols: 1 } } },
          }],
          save: true,
        },
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('blocks[0].responsive');
    expect(body.error).toContain('data.cols');
  });

  it('PUT preserves system fields but replaces writable ones', async () => {
    const { token } = await setup();
    await seedPage('home', {
      title: 'Home', html_content: '<h1>old</h1>', seo_title: 'old SEO', kind: 'page',
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PUT',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { title: 'Home', html_content: '<h1>new</h1>', save: true } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { page: { html_content: string; seo_title?: string | null } };
    expect(body.page.html_content).toBe('<h1>new</h1>');
    // PUT replaced — seo_title is cleared (null after the replace commit).
    expect(body.page.seo_title ?? null).toBeNull();
  });

  it('DELETE removes the page', async () => {
    const { token } = await setup();
    await seedPage('home', {});
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const { vstore } = await import('../../lib/version-store');
    expect(await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home')).toBeNull();
  });

  it('404 for an unknown page', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/nope`,
      { siteId: SITE, pageId: 'nope' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/sites/{siteId}/pages/batch-read', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns docs for ids that exist, flags the rest', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home' });
    await seedPage('about', { title: 'About' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/batch-read'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/batch-read`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_ids: ['home', 'about', 'nope'] } },
    );
    const body = await res.json() as { pages: Array<{ page_id: string; found: boolean }> };
    expect(body.pages.find((p) => p.page_id === 'home')?.found).toBe(true);
    expect(body.pages.find((p) => p.page_id === 'nope')?.found).toBe(false);
  });

  it('rejects more than 200 ids', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/batch-read'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/batch-read`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_ids: Array.from({ length: 201 }, (_, i) => `p${i}`) } },
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/sites/{siteId}/pages/batch-write', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('applies patches per-row, reports per-row outcomes', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home', html_content: '<p>a</p>' });
    await seedPage('about', { title: 'About', html_content: '<p>b</p>' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/batch-write'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/batch-write`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: [
          { page_id: 'home', patch: { html_content: '<p>new home</p>' }, save: true },
          { page_id: 'about', patch: { html_content: '<p>new about</p>' }, save: true },
          { page_id: 'nope', patch: { html_content: '<p>x</p>' } },
          { page_id: 'home', patch: {} },          // no writable fields
        ],
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ page_id: string; ok: boolean; error?: string }> };
    expect(body.results.find((r) => r.page_id === 'home' && r.ok)?.ok).toBe(true);
    expect(body.results.find((r) => r.page_id === 'about' && r.ok)?.ok).toBe(true);
    expect(body.results.find((r) => r.page_id === 'nope')?.error).toContain('not found');
    expect(body.results.find((r) => r.page_id === 'home' && !r.ok)?.error).toContain('no writable fields');

    const { vstore } = await import('../../lib/version-store');
    const home = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(home?.html_content).toBe('<p>new home</p>');
  });

  it('assigns stable unique IDs to nested batch-written blocks before saving', async () => {
    const { token } = await setup();
    await seedPage('home', { content_mode: 'blocks', blocks: [] });
    const blocks = [{ id: 'keep', type: 'core/section', data: {}, children: [
      { type: 'core/heading', data: { text: 'Heading', level: 'h2' } },
    ], slots: [[{ id: 'keep', type: 'core/prose', data: { html: '<p>Content</p>' } }]] }];
    const write = async (tree: unknown) => callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/batch-write'), 'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/batch-write`, { siteId: SITE },
      { headers: bearer(token), body: [{ page_id: 'home', patch: { blocks: tree }, save: true }] },
    );
    expect((await (await write(blocks)).json()).results[0]).toMatchObject({ ok: true, saved: true });
    const { vstore } = await import('../../lib/version-store');
    const page = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    const section = page!.blocks![0]!;
    const ids = [section.id, section.children![0]!.id, section.slots![0]![0]!.id];
    expect(ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(section.id).toBe('keep');
    expect(section.children![0]!.data).toEqual(blocks[0]!.children[0]!.data);
    await write(page!.blocks);
    expect((await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home'))!.blocks).toEqual(page!.blocks);
  });

  it('reports content_mode as a per-row error instead of silently ignoring it', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home', content_mode: 'html' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/batch-write'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages/batch-write`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: [{ page_id: 'home', patch: { content_mode: 'blocks' } }],
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ ok: boolean; error?: string }> };
    expect(body.results[0]).toMatchObject({ ok: false });
    expect(body.results[0].error).toContain('/mode');
  });
});

describe('rate limiting', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('responds 429 with Retry-After when the write bucket is exhausted', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home' });
    // The write bucket is 60/min. Fire 61 PATCHes back to back; the 61st
    // should bounce.
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await callRoute(
        import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
        'PATCH',
        `http://localhost/api/v1/sites/${SITE}/pages/home`,
        { siteId: SITE, pageId: 'home' },
        { headers: bearer(token), body: { html_content: `<p>${i}</p>` } },
      );
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('audit log', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('writes an audit entry per state-changing call, not for GETs', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Home' });

    // GET — should NOT be audited.
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token) },
    );
    // PATCH — should be audited.
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { html_content: '<p>via-api</p>' } },
    );

    // Audit writes are fire-and-forget; give them a tick.
    await new Promise((r) => setTimeout(r, 20));
    const { getStore } = await import('../../lib/datastore');
    const audit = await getStore().listDocs(paths.apiAudit(ORG, SITE));
    expect(audit.length).toBe(1);
    const entry = audit[0] as unknown as { method: string; path: string };
    expect(entry.method).toBe('PATCH');
    expect(entry.path).toContain('/pages/home');
  });
});

describe('native presentation metadata', () => {
  it('round-trips breadcrumb labels through creation, batch writes and reads without changing routes', async () => {
    const { token } = await setup();
    const base = `http://localhost/api/v1/sites/${SITE}/pages`;
    const created = await callRoute(import('../../pages/api/v1/sites/[siteId]/pages/index'), 'POST', base, { siteId: SITE }, { headers: bearer(token), body: { title: 'A deliberately long page title', breadcrumb_label: 'Short', slug: 'guide', content_mode: 'blocks', blocks: [] } });
    expect(created.status).toBe(201);
    const { page } = await created.json();
    const read = () => callRoute(import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'), 'GET', `${base}/${page.id}`, { siteId: SITE, pageId: page.id }, { headers: bearer(token) });
    expect((await (await read()).json()).page.breadcrumb_label).toBe('Short');
    const result = await callRoute(import('../../pages/api/v1/sites/[siteId]/pages/batch-write'), 'POST', `${base}/batch-write`, { siteId: SITE }, { headers: bearer(token), body: [{ page_id: page.id, patch: { breadcrumb_label: 'Updated' }, save: true }] });
    expect(result.status).toBe(200);
    const saved = (await (await read()).json()).page;
    expect(saved.breadcrumb_label).toBe('Updated');
    expect(saved.title).toBe('A deliberately long page title');
    expect(saved.slug).toBe('guide');
    const invalid = await callRoute(import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'), 'PATCH', `${base}/${page.id}`, { siteId: SITE, pageId: page.id }, { headers: bearer(token), body: { breadcrumb_label: { invalid: true } } });
    expect(invalid.status).toBe(400);
  });
  it('validates and resets site responsive widths through the real settings API', async () => {
    const { token } = await setup();
    const endpoint = `http://localhost/api/v1/sites/${SITE}/settings`;
    const route = import('../../pages/api/v1/sites/[siteId]/settings');
    const write = (value: unknown) => callRoute(route, 'PATCH', endpoint, { siteId: SITE }, { headers: bearer(token), body: { responsive_breakpoints: value } });
    const widths = { tablet: 576, laptop: 769, desktop: 1024, wide: 1280 };
    expect((await write(widths)).status).toBe(200);
    expect((await write({ ...widths, laptop: 500 })).status).toBe(400);
    const read = await callRoute(route, 'GET', endpoint, { siteId: SITE }, { headers: bearer(token) });
    expect((await read.json()).settings.responsive_breakpoints).toEqual(widths);
    expect((await write(null)).status).toBe(200);
  });
});
