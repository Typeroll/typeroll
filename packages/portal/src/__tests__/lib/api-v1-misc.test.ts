// Tests for the remaining /v1 endpoints: settings, media (list + patch +
// delete; upload-url smoke), redirects, forms (read-only), search,
// bulk-replace.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Media, Site, SiteSettings, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' });
  return { token };
}

interface CallInit { headers?: HeadersInit; body?: unknown }
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
  const body = init?.body != null && typeof init.body !== 'string' ? JSON.stringify(init.body) : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

async function seedPage(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: '<p>seed</p>', ...doc,
  });
}

describe('settings endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET returns scripts_* and custom_css (API caller is trusted)', async () => {
    const { token } = await setup();
    const { vstore } = await import('../../lib/version-store');
    await vstore.writeSettings(ORG, SITE, MAIN_VERSION_ID, {
      site_name: 'My Site', scripts_head: '<script>console.log(1)</script>', custom_css: 'body{color:red}',
    } as Partial<SiteSettings>);

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { settings: Record<string, unknown> };
    expect(body.settings.site_name).toBe('My Site');
    expect(body.settings.scripts_head).toBe('<script>console.log(1)</script>');
    expect(body.settings.custom_css).toBe('body{color:red}');
  });

  it('PATCH accepts scripts_* and custom_css via API key', async () => {
    const { token } = await setup();
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token), body: {
        site_name: 'Changed',
        scripts_head: '<script>x</script>',
        scripts_body_end: '<script>y</script>',
        custom_css: '.x{color:red}',
        colors: { primary: '#ff5500' },
      } },
    );
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(settings?.site_name).toBe('Changed');
    expect(settings?.scripts_head).toBe('<script>x</script>');
    expect(settings?.scripts_body_end).toBe('<script>y</script>');
    expect(settings?.custom_css).toBe('.x{color:red}');
    expect(settings?.colors?.primary).toBe('#ff5500');
  });

  it('PATCH round-trips default_meta_description', async () => {
    const { token } = await setup();
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token), body: { default_meta_description: 'Fallback description for all pages.' } },
    );
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(settings?.default_meta_description).toBe('Fallback description for all pages.');

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { settings: Record<string, unknown> };
    expect(body.settings.default_meta_description).toBe('Fallback description for all pages.');
  });

  it('PATCH still drops unknown keys', async () => {
    const { token } = await setup();
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token), body: {
        site_name: 'Y',
        nonsense_field: 'should-be-dropped',
      } },
    );
    const { vstore } = await import('../../lib/version-store');
    const settings = (await vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as unknown as Record<string, unknown>;
    expect(settings.site_name).toBe('Y');
    expect(settings.nonsense_field).toBeUndefined();
  });

  it('PATCH shallow-merges nested objects', async () => {
    const { token } = await setup();
    const { vstore } = await import('../../lib/version-store');
    await vstore.writeSettings(ORG, SITE, MAIN_VERSION_ID, {
      colors: { primary: '#000', secondary: '#fff' },
    } as Partial<SiteSettings>);
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token), body: { colors: { primary: '#ff5500' } } },
    );
    const s = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(s?.colors?.primary).toBe('#ff5500');
    expect(s?.colors?.secondary).toBe('#fff');
  });

  it('PATCH configures native cookie consent and preserves omitted fields', async () => {
    const { token } = await setup();
    const { vstore } = await import('../../lib/version-store');
    await vstore.writeSettings(ORG, SITE, MAIN_VERSION_ID, {
      cookie_consent: { enabled: false, text: 'Existing copy', privacy_policy_url: '/privacy/' },
    } as Partial<SiteSettings>);
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token), body: { cookie_consent: { enabled: true } } },
    );
    expect(res.status).toBe(200);
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(settings?.cookie_consent).toEqual({
      enabled: true,
      text: 'Existing copy',
      privacy_policy_url: '/privacy/',
    });
  });
});

describe('media endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET lists media with cursor pagination', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    for (let i = 0; i < 3; i++) {
      await getStore().addDoc(paths.media(ORG, SITE), {
        filename: `img-${i}.png`, cdn_url: `https://cdn/x/${i}`, mime_type: 'image/png',
        created_at: new Date(2026, 0, i + 1).toISOString(),
      } satisfies Partial<Media>);
    }
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/media/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/media?limit=2`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { media: Array<{ id: string }>; next_cursor: string | null };
    expect(body.media.length).toBe(2);
    expect(body.next_cursor).toBeTruthy();
  });

  it('PATCH updates writable fields only', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    const mediaId = await getStore().addDoc(paths.media(ORG, SITE), {
      filename: 'old.png', cdn_url: 'https://cdn/x', mime_type: 'image/png',
      created_at: new Date().toISOString(), alt_text: 'old',
    } satisfies Partial<Media>);
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/media/[mediaId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/media/${mediaId}`,
      { siteId: SITE, mediaId },
      { headers: bearer(token), body: { alt_text: 'new', mime_type: 'image/jpeg' /* not writable */ } },
    );
    const doc = await getStore().getDoc<Media>(`${paths.media(ORG, SITE)}/${mediaId}`);
    expect(doc?.alt_text).toBe('new');
    expect(doc?.mime_type).toBe('image/png');
  });
});

describe('redirects endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('POST creates with derived id; GET lists; DELETE removes', async () => {
    const { token } = await setup();

    const post = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/redirects/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/redirects`,
      { siteId: SITE },
      { headers: bearer(token), body: { from_path: '/old-about', to_path: '/about' } },
    );
    expect(post.status).toBe(201);
    const created = await post.json() as { redirect: { id: string } };

    const listRes = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/redirects/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/redirects`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const list = await listRes.json() as { redirects: Array<{ id: string }> };
    expect(list.redirects.map((r) => r.id)).toContain(created.redirect.id);

    const del = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/redirects/[redirectId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/redirects/${created.redirect.id}`,
      { siteId: SITE, redirectId: created.redirect.id },
      { headers: bearer(token) },
    );
    expect(del.status).toBe(200);
  });
});

describe('forms endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET / lists forms with shaped fields', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
      name: 'Contact',
      steps: [{ id: 'main', blocks: [
        { id: 'f-name', type: 'form/text', data: { name: 'name', label: 'Name', required: true, secret_internal: 'no' } },
        { id: 'f-email', type: 'form/email', data: { name: 'email', label: 'Email' } },
      ] }],
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/forms`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { forms: Array<{ id: string; fields: Array<{ name: string }> }> };
    expect(body.forms[0].id).toBe('contact');
    // The derived field summary is a clean projection (collectStepFields) —
    // block-data junk never leaks into it. (Raw steps ARE returned in full;
    // they're the model, same as the single-form GET.)
    expect(body.forms[0].fields.map((f) => f.name).sort()).toEqual(['email', 'name']);
    expect(JSON.stringify(body.forms[0].fields)).not.toContain('secret_internal');
  });
});

describe('GET /search', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns excerpted matches for contains query', async () => {
    const { token } = await setup();
    await seedPage('home', { html_content: '<p>price is 299 kr</p>' });
    await seedPage('about', { html_content: '<p>About us</p>' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/search'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/search?contains=299%20kr`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { matches: Array<{ page_id: string; excerpt: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.matches[0].page_id).toBe('home');
    expect(body.matches[0].excerpt).toContain('299');
  });

  it('400 without contains or regex', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/search'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/search`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /bulk-replace', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('dry_run returns counts without writing', async () => {
    const { token } = await setup();
    await seedPage('home', { html_content: '<p>299 kr</p>' });

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/bulk-replace'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/bulk-replace`,
      { siteId: SITE },
      { headers: bearer(token), body: { pattern: '299 kr', replacement: '349 kr', dry_run: true } },
    );
    const body = await res.json() as { dry_run: boolean; total_matches: number; updated: number };
    expect(body.dry_run).toBe(true);
    expect(body.total_matches).toBe(1);
    expect(body.updated).toBe(0);

    const { vstore } = await import('../../lib/version-store');
    const home = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(home?.html_content).toContain('299 kr');
  });

  it('real run writes through vstore', async () => {
    const { token } = await setup();
    await seedPage('home', { html_content: '<p>299 kr</p>' });
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/bulk-replace'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/bulk-replace`,
      { siteId: SITE },
      { headers: bearer(token), body: { pattern: '299 kr', replacement: '349 kr', save: true } },
    );
    const { vstore } = await import('../../lib/version-store');
    const home = await vstore.page(ORG, SITE, MAIN_VERSION_ID, 'home');
    expect(home?.html_content).toContain('349 kr');
  });

  it('400 when pattern is missing', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/bulk-replace'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/bulk-replace`,
      { siteId: SITE },
      { headers: bearer(token), body: { pattern: '', replacement: 'x' } },
    );
    expect(res.status).toBe(400);
  });
});
