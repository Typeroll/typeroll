// Tests for the preview endpoints: POST /v1/.../preview-link,
// GET /v1/.../pages/{pageId}/preview, GET /preview/{siteId}/{slug}.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const SECRET = 'a-very-long-secret-string-at-least-32-chars-x';

async function setup(): Promise<{ token: string }> {
  process.env.PREVIEW_HMAC_SECRET = SECRET;
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

async function seedPage(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: '<p>seed</p>', ...doc,
  });
}

interface CallInit { headers?: HeadersInit; body?: unknown }
async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST', APIRoute>>>,
  method: 'GET' | 'POST',
  url: string,
  params: Record<string, string | undefined>,
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
  return handler({ request: req, params: params as Record<string, string>, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

describe('POST /v1/.../preview-link', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('mints a signed URL pointing at the public preview route', async () => {
    const { token } = await setup();
    await seedPage('about', {});

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/preview-link'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/preview-link`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_id: 'about' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string; expires_at: string };
    expect(body.url).toMatch(new RegExp(`/preview/${SITE}/about\\?t=`));
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('home page URL omits the slug segment', async () => {
    const { token } = await setup();
    await seedPage('home', { slug: 'home' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/preview-link'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/preview-link`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_id: 'home' } },
    );
    const body = await res.json() as { url: string };
    expect(body.url).toMatch(new RegExp(`/preview/${SITE}/?\\?t=`));
  });

  it('503 when PREVIEW_HMAC_SECRET is missing', async () => {
    const { token } = await setup();
    delete process.env.PREVIEW_HMAC_SECRET;
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/preview-link'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/preview-link`,
      { siteId: SITE },
      { headers: bearer(token), body: {} },
    );
    expect(res.status).toBe(503);
  });
});

describe('GET /preview/{siteId}/{slug}', () => {
  const frame = '&frame=1&bridge=12345678-1234-1234-1234-123456789abc';
  beforeEach(async () => { await resetDatastore(); });

  it('renders the page when given a valid token', async () => {
    const { token } = await setup();
    await seedPage('about', { html_content: '<h1>About</h1>' });

    // Mint a token via the API so the test exercises the same path.
    const minted = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/preview-link'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/preview-link`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_id: 'about' } },
    );
    const { url } = await minted.json() as { url: string };
    const parsed = new URL(url);
    const t = parsed.searchParams.get('t')!;

    const res = await callRoute(
      import('../../pages/preview/[siteId]/[...slug]'),
      'GET',
      `http://localhost/preview/${SITE}/about?t=${encodeURIComponent(t)}${frame}`,
      { siteId: SITE, slug: 'about' },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('About');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('resolves nested pages by their explicit path instead of their leaf slug', async () => {
    const { token } = await setup();
    await seedPage('transport', {
      slug: 'transport-kategori',
      path: '/tips-om-flytt/transport-kategori',
      html_content: '<h1>Transport category</h1>',
    });
    const minted = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/preview-link'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/preview-link`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_id: 'transport' } },
    );
    const { url } = await minted.json() as { url: string };
    const t = new URL(url).searchParams.get('t')!;

    const nested = await callRoute(
      import('../../pages/preview/[siteId]/[...slug]'),
      'GET',
      `http://localhost/preview/${SITE}/tips-om-flytt/transport-kategori?t=${encodeURIComponent(t)}${frame}`,
      { siteId: SITE, slug: 'tips-om-flytt/transport-kategori' },
    );
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain('Transport category');

    const leafOnly = await callRoute(
      import('../../pages/preview/[siteId]/[...slug]'),
      'GET',
      `http://localhost/preview/${SITE}/transport-kategori?t=${encodeURIComponent(t)}${frame}`,
      { siteId: SITE, slug: 'transport-kategori' },
    );
    expect(leafOnly.status).toBe(404);
  });

  it('401 with no token', async () => {
    await setup();
    await seedPage('home', {});
    const res = await callRoute(
      import('../../pages/preview/[siteId]/[...slug]'),
      'GET',
      `http://localhost/preview/${SITE}/`,
      { siteId: SITE, slug: '' },
    );
    expect(res.status).toBe(401);
  });

  it('401 when token belongs to a different site', async () => {
    const { token } = await setup();
    await seedPage('about', {});
    // Mint a token for "mysite" then attempt to use it on a different siteId.
    const minted = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/preview-link'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/preview-link`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_id: 'about' } },
    );
    const { url } = await minted.json() as { url: string };
    const t = new URL(url).searchParams.get('t')!;

    const res = await callRoute(
      import('../../pages/preview/[siteId]/[...slug]'),
      'GET',
      `http://localhost/preview/othersite/about?t=${encodeURIComponent(t)}`,
      { siteId: 'othersite', slug: 'about' },
    );
    expect(res.status).toBe(401);
  });
});

describe('working-copy previews for agents', () => {
  const frame = '&frame=1&bridge=12345678-1234-1234-1234-123456789abc';
  beforeEach(async () => { await resetDatastore(); });

  async function seedWc(pageId: string, html: string): Promise<void> {
    const { mergeWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(
      { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID },
      { kind: 'page', id: pageId },
      { html_content: html },
    );
  }

  it('GET /v1 page preview shows saved content by default, working copy with ?working_copy=true', async () => {
    const { token } = await setup();
    await seedPage('about', { html_content: '<h1>Sparat innehåll</h1>' });
    await seedWc('about', '<h1>Osparat utkast</h1>');

    const saved = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/preview'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/about/preview`,
      { siteId: SITE, pageId: 'about' },
      { headers: bearer(token) },
    );
    const savedBody = await saved.json() as { rendered_html: string; working_copy_included: boolean };
    expect(savedBody.rendered_html).toContain('Sparat innehåll');
    expect(savedBody.rendered_html).not.toContain('Osparat utkast');
    expect(savedBody.working_copy_included).toBe(false);

    const wc = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/preview'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/pages/about/preview?working_copy=true`,
      { siteId: SITE, pageId: 'about' },
      { headers: bearer(token) },
    );
    const wcBody = await wc.json() as { rendered_html: string; working_copy_included: boolean };
    expect(wcBody.rendered_html).toContain('Osparat utkast');
    expect(wcBody.working_copy_included).toBe(true);
  });

  it('preview-link include_working_copy is signed into the token and honoured by /preview', async () => {
    const { token } = await setup();
    await seedPage('about', { html_content: '<h1>Sparat innehåll</h1>' });
    await seedWc('about', '<h1>Osparat utkast</h1>');

    async function mint(includeWc: boolean): Promise<string> {
      const res = await callRoute(
        import('../../pages/api/v1/sites/[siteId]/preview-link'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/preview-link`,
        { siteId: SITE },
        { headers: bearer(token), body: { page_id: 'about', include_working_copy: includeWc } },
      );
      const { url } = await res.json() as { url: string };
      return new URL(url).searchParams.get('t')!;
    }

    async function render(t: string): Promise<string> {
      const res = await callRoute(
        import('../../pages/preview/[siteId]/[...slug]'),
        'GET',
        `http://localhost/preview/${SITE}/about?t=${encodeURIComponent(t)}${frame}`,
        { siteId: SITE, slug: 'about' },
      );
      expect(res.status).toBe(200);
      return res.text();
    }

    const plainHtml = await render(await mint(false));
    expect(plainHtml).toContain('Sparat innehåll');
    expect(plainHtml).not.toContain('Osparat utkast');

    const wcHtml = await render(await mint(true));
    expect(wcHtml).toContain('Osparat utkast');
  });

  it('a tampered wc flag invalidates the token', async () => {
    const { token } = await setup();
    await seedPage('about', {});
    const minted = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/preview-link'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/preview-link`,
      { siteId: SITE },
      { headers: bearer(token), body: { page_id: 'about' } },
    );
    const { url } = await minted.json() as { url: string };
    const t = new URL(url).searchParams.get('t')!;
    // Flip wc=true inside the payload without re-signing.
    const [payload, sig] = t.split('.');
    const ticket = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    ticket.wc = true;
    const forged = `${Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')}.${sig}`;

    const res = await callRoute(
      import('../../pages/preview/[siteId]/[...slug]'),
      'GET',
      `http://localhost/preview/${SITE}/about?t=${encodeURIComponent(forged)}`,
      { siteId: SITE, slug: 'about' },
    );
    expect(res.status).toBe(401);
  });
});
