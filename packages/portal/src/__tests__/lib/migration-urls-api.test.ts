// v1 migration-inventory endpoints + the hreflang write gate on pages.
//
// The inventory is what a migration is measured against, so the two
// properties pinned hardest here are: (1) nothing is dropped silently, and
// (2) coverage is recomputed from live state, never cached.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const BASE = `http://localhost/api/v1/sites/${SITE}/migration-urls`;

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
  const { token } = await createApiKey({
    orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com',
  });
  return { token };
}

async function call(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: { token?: string; body?: unknown },
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const req = new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

const indexRoute = () => import('../../pages/api/v1/sites/[siteId]/migration-urls/index');
const itemRoute = () => import('../../pages/api/v1/sites/[siteId]/migration-urls/[urlId]');

describe('v1 migration-urls', () => {
  let token: string;
  beforeEach(async () => {
    ({ token } = await setup());
  });

  it('rejects an unauthenticated read', async () => {
    const res = await call(indexRoute(), 'GET', BASE, { siteId: SITE });
    expect(res.status).toBe(401);
  });

  it('bulk-adds URLs and reports coverage as unhandled', async () => {
    const res = await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token,
      body: {
        source: 'sitemap',
        source_origin: 'https://old.example.com',
        urls: [
          { url: 'https://old.example.com/om-oss' },
          { url: '/kontakt', gsc_clicks: 120 },
        ],
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.added).toBe(2);
    expect(body.summary.unhandled).toBe(2);
  });

  it('is idempotent — re-posting merges instead of duplicating', async () => {
    const post = () => call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token,
      body: { urls: [{ url: 'https://old.example.com/om-oss', source: 'sitemap' }] },
    });
    await post();
    const second = await (await post()).json();
    expect(second.added).toBe(0);
    expect(second.merged).toBe(1);
    expect(second.summary.total).toBe(1);
  });

  it('rejects a foreign-origin URL instead of folding it in silently', async () => {
    // The multisite guard: domain B's /kontakt must never count as coverage
    // for domain A, which shares the path.
    const res = await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token,
      body: {
        source_origin: 'https://old.example.com',
        urls: [
          { url: 'https://old.example.com/kontakt' },
          { url: 'https://other-market.example.de/kontakt' },
        ],
      },
    });
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].reason).toContain('different origin');
  });

  it('flips an entry to migrated once a published page answers at that path', async () => {
    const { getStore } = await import('../../lib/datastore');
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token, body: { urls: [{ url: '/om-oss' }] },
    });
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/om-oss`, {
      title: 'Om oss', slug: 'om-oss', status: 'published', content_mode: 'html',
      html_content: '<p>hej</p>',
    } satisfies Partial<Page>);

    const res = await call(indexRoute(), 'GET', BASE, { siteId: SITE }, { token });
    const body = await res.json();
    expect(body.summary.migrated).toBe(1);
    expect(body.summary.unhandled).toBe(0);
    expect(body.urls[0].target).toBe('/om-oss');
  });

  it('filters by status but keeps the summary describing the whole inventory', async () => {
    const { getStore } = await import('../../lib/datastore');
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token, body: { urls: [{ url: '/a' }, { url: '/b' }] },
    });
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/a`, {
      title: 'A', slug: 'a', status: 'published', content_mode: 'html', html_content: '',
    } satisfies Partial<Page>);

    const res = await call(indexRoute(), 'GET', `${BASE}?status=unhandled`, { siteId: SITE }, { token });
    const body = await res.json();
    expect(body.urls).toHaveLength(1);
    expect(body.urls[0].path).toBe('/b');
    expect(body.summary.total).toBe(2);
  });

  it('marks an entry excluded, moving it out of the work list', async () => {
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token, body: { urls: [{ url: '/wp-admin' }] },
    });
    const patch = await call(itemRoute(), 'PATCH', `${BASE}/wp-admin`, { siteId: SITE, urlId: 'wp-admin' }, {
      token, body: { excluded: true, notes: 'signed off' },
    });
    expect(patch.status).toBe(200);
    const list = await (await call(indexRoute(), 'GET', BASE, { siteId: SITE }, { token })).json();
    expect(list.summary.excluded).toBe(1);
    expect(list.summary.unhandled).toBe(0);
  });

  it('bulk-updates ids or an entire source in one PATCH', async () => {
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token,
      body: {
        urls: [
          { url: '/a', source: 'wordpress-redirect-guess' },
          { url: '/b', source: 'wordpress-redirect-guess' },
          { url: '/c', source: 'sitemap' },
        ],
      },
    });
    const response = await call(indexRoute(), 'PATCH', BASE, { siteId: SITE }, {
      token,
      body: {
        where: { source: 'wordpress-redirect-guess' },
        patch: { excluded: true, notes: 'reviewed as CMS guesses' },
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matched).toBe(2);
    expect(body.updated).toBe(2);
    expect(body.summary).toMatchObject({ excluded: 2, unhandled: 1 });

    const missing = await call(indexRoute(), 'PATCH', BASE, { siteId: SITE }, {
      token, body: { ids: ['c', 'does-not-exist'], patch: { excluded: true } },
    });
    expect((await missing.json()).not_found).toEqual(['does-not-exist']);
  });

  it('rejects inventory ids that Firestore reserves instead of returning 500', async () => {
    const response = await call(indexRoute(), 'PATCH', BASE, { siteId: SITE }, {
      token,
      body: { ids: ['__reserved__'], patch: { excluded: true } },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('invalid inventory URL ids');
  });

  it('404s a patch against an unknown entry rather than creating one', async () => {
    const res = await call(itemRoute(), 'PATCH', `${BASE}/nope`, { siteId: SITE, urlId: 'nope' }, {
      token, body: { excluded: true },
    });
    expect(res.status).toBe(404);
  });

  it('refuses fields outside the whitelist', async () => {
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, { token, body: { urls: [{ url: '/x' }] } });
    const res = await call(itemRoute(), 'PATCH', `${BASE}/x`, { siteId: SITE, urlId: 'x' }, {
      token, body: { path: '/hacked' },
    });
    expect(res.status).toBe(400);
  });

  it('deletes an entry', async () => {
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, { token, body: { urls: [{ url: '/x' }] } });
    const res = await call(itemRoute(), 'DELETE', `${BASE}/x`, { siteId: SITE, urlId: 'x' }, { token });
    expect(res.status).toBe(200);
    const list = await (await call(indexRoute(), 'GET', BASE, { siteId: SITE }, { token })).json();
    expect(list.summary.total).toBe(0);
  });

  it('classifies WordPress bare-slug guesses as auto-excluded evidence', async () => {
    const { addWordPressBareSlugGuess } = await import('../../lib/wp/url-inventory');
    const { getStore } = await import('../../lib/datastore');
    expect(await addWordPressBareSlugGuess(
      getStore(), ORG, SITE,
      'https://old.example.com/blog/hello/', 'hello', 'https://old.example.com',
    )).toBe(true);
    const list = await (await call(indexRoute(), 'GET', BASE, { siteId: SITE }, { token })).json();
    expect(list.urls[0]).toMatchObject({
      path: '/hello', excluded: true, status: 'excluded', sources: ['wordpress-redirect-guess'],
    });
  });
});

describe('v1 migration-urls/verify', () => {
  let token: string;
  const verifyRoute = () => import('../../pages/api/v1/sites/[siteId]/migration-urls/verify');

  beforeEach(async () => {
    ({ token } = await setup());
  });

  it('refuses to guess an origin when the site has none', async () => {
    const res = await call(verifyRoute(), 'POST', `${BASE}/verify`, { siteId: SITE }, { token, body: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('target_origin');
  });

  it('requires source_origin before it will check the old site', async () => {
    const res = await call(verifyRoute(), 'POST', `${BASE}/verify`, { siteId: SITE }, {
      token, body: { target_origin: 'https://new.example.com', check_source: true },
    });
    expect(res.status).toBe(400);
  });

  it('reports the gaps a coverage report cannot see', async () => {
    const { getStore } = await import('../../lib/datastore');
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token, body: { urls: [{ url: '/finns' }, { url: '/borta' }] },
    });
    // Both entries LOOK handled: one has a published page, the other a
    // redirect rule. Only one of them actually answers.
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/finns`, {
      title: 'Finns', slug: 'finns', status: 'published', content_mode: 'html', html_content: '',
    } satisfies Partial<Page>);
    await getStore().setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/borta`, {
      from_path: '/borta', to_path: '/aldrig-publicerad', status_code: 301,
    });

    const routes: Record<string, number> = {
      'https://new.example.com/finns': 200,
      'https://new.example.com/borta': 404,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return new Response(null, { status: routes[url] ?? 500 });
    }) as unknown as typeof fetch;
    try {
      const res = await call(verifyRoute(), 'POST', `${BASE}/verify`, { siteId: SITE }, {
        token, body: { target_origin: 'https://new.example.com' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.ok).toBe(1);
      expect(body.summary.missing).toBe(1);
      expect(body.results).toHaveLength(1);
      expect(body.gaps).toHaveLength(1);
      expect(body.gaps[0].path).toBe('/borta');
      // …and the redirect rule it exercised is now stamped as unverified.
      const rule = await getStore().getDoc<{ verified?: boolean }>(
        `${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/borta`,
      );
      expect(rule?.verified).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('supports an exact verdict filter without leaking other gaps', async () => {
    await call(indexRoute(), 'POST', BASE, { siteId: SITE }, {
      token, body: { urls: [{ url: '/gone' }, { url: '/fine' }] },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(null, { status: url.endsWith('/fine') ? 200 : 404 });
    }) as typeof fetch;
    try {
      const response = await call(verifyRoute(), 'POST', `${BASE}/verify`, { siteId: SITE }, {
        token, body: { target_origin: 'https://new.example.com', verdicts: ['ok'] },
      });
      const body = await response.json();
      expect(body.results.map((entry: { verdict: string }) => entry.verdict)).toEqual(['ok']);
      expect(body.gaps).toEqual([]);
      expect(body.omitted_results).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('v1 migration URL imports', () => {
  let token: string;
  beforeEach(async () => { ({ token } = await setup()); });

  it('imports an explicit recursive sitemap', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/index.xml')) {
        return new Response('<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap></sitemapindex>');
      }
      return new Response('<urlset><url><loc>https://example.com/hidden</loc></url></urlset>');
    }) as typeof fetch;
    try {
      const response = await call(
        import('../../pages/api/v1/sites/[siteId]/migration-urls/import-sitemap'),
        'POST', `${BASE}/import-sitemap`, { siteId: SITE },
        { token, body: { url: 'https://example.com/index.xml' } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ discovered: 1, added: 1, sitemaps_read: 2 });
      expect(body.coverage.unhandled).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('imports GSC CSV and reports URLs missing from the prior inventory', async () => {
    const response = await call(
      import('../../pages/api/v1/sites/[siteId]/migration-urls/import-gsc'),
      'POST', `${BASE}/import-gsc`, { siteId: SITE },
      {
        token,
        body: {
          csv: 'Page,Clicks,Impressions\nhttps://old.example.com/forgotten#one,2,5\nhttps://old.example.com/forgotten#two,3,7',
          source_origin: 'https://old.example.com',
        },
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ rows: 1, added: 1, unhandled_imported: 1 });
    expect(body.unhandled_urls).toEqual(['/forgotten']);
    const list = await (await call(indexRoute(), 'GET', BASE, { siteId: SITE }, { token })).json();
    expect(list.urls[0]).toMatchObject({ gsc_clicks: 5, gsc_impressions: 12 });
  });
});

describe('v1 pages — hreflang alternates', () => {
  let token: string;
  const pagesUrl = `http://localhost/api/v1/sites/${SITE}/pages`;
  const pageRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]');

  beforeEach(async () => {
    ({ token } = await setup());
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/om-oss`, {
      title: 'Om oss', slug: 'om-oss', status: 'published', content_mode: 'html',
      html_content: '<p>hej</p>',
    } satisfies Partial<Page>);
  });

  it('stores a canonicalized cluster', async () => {
    const res = await call(pageRoute(), 'PATCH', `${pagesUrl}/om-oss`, { siteId: SITE, pageId: 'om-oss' }, {
      token,
      body: {
        save: true,
        alternates: [
          { hreflang: 'en-gb', href: 'https://example.co.uk/about-us' },
          { hreflang: 'x-default', href: 'https://example.com/about-us' },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page.alternates).toEqual([
      { hreflang: 'en-GB', href: 'https://example.co.uk/about-us' },
      { hreflang: 'x-default', href: 'https://example.com/about-us' },
    ]);
  });

  it('rejects the whole write when an entry is malformed, naming the reason', async () => {
    const res = await call(pageRoute(), 'PATCH', `${pagesUrl}/om-oss`, { siteId: SITE, pageId: 'om-oss' }, {
      token,
      body: { alternates: [{ hreflang: 'de', href: '/relative' }] },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('invalid href for de');

    // …and nothing was written.
    const after = await call(pageRoute(), 'GET', `${pagesUrl}/om-oss`, { siteId: SITE, pageId: 'om-oss' }, { token });
    expect((await after.json()).page.alternates).toBeUndefined();
  });

  it('rejects a tag that would break out of the attribute', async () => {
    const res = await call(pageRoute(), 'PATCH', `${pagesUrl}/om-oss`, { siteId: SITE, pageId: 'om-oss' }, {
      token,
      body: { alternates: [{ hreflang: 'en" onload="x', href: 'https://example.com/' }] },
    });
    expect(res.status).toBe(400);
  });

  it('clears the cluster with null', async () => {
    await call(pageRoute(), 'PATCH', `${pagesUrl}/om-oss`, { siteId: SITE, pageId: 'om-oss' }, {
      token,
      body: { save: true, alternates: [{ hreflang: 'de', href: 'https://example.de/ueber-uns' }] },
    });
    const res = await call(pageRoute(), 'PATCH', `${pagesUrl}/om-oss`, { siteId: SITE, pageId: 'om-oss' }, {
      token, body: { save: true, alternates: null },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page.alternates ?? null).toBeNull();
  });
});
