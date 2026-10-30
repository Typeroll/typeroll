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

  it('persists named scales and audits the authenticated site without writes', async () => {
    const { token } = await setup();
    const endpoint = import('../../pages/api/v1/sites/[siteId]/settings');
    const response = await callRoute(endpoint, 'PATCH', `http://localhost/api/v1/sites/${SITE}/settings`, {siteId:SITE},
      {headers:bearer(token),body:{design_scales:{space:{lg:'2rem'}},fonts:{mono:'Roboto Mono'},colors:{surface_hover:'#abcdef'}}});
    expect(response.status).toBe(200);
    const { vstore } = await import('../../lib/version-store');
    expect(await vstore.settings(ORG,SITE,MAIN_VERSION_ID)).toMatchObject({design_scales:{space:{lg:'2rem'}},fonts:{mono:'Roboto Mono'}});
    const bad = await callRoute(endpoint, 'PATCH', `http://localhost/api/v1/sites/${SITE}/settings`, {siteId:SITE},
      {headers:bearer(token),body:{design_scales:{space:{lg:'2px;display:none'}}}});
    expect(bad.status).toBe(400);
    await seedPage('audit', {content_mode:'blocks',blocks:[{id:'text',type:'core/prose',data:{font_size_px:17}}]});
    const auditEndpoint = import('../../pages/api/v1/sites/[siteId]/design-token-audit');
    const audit = await callRoute(auditEndpoint,'GET',`http://localhost/api/v1/sites/${SITE}/design-token-audit`,{siteId:SITE},{headers:bearer(token)});
    expect(audit.status).toBe(200);
    expect(await audit.json()).toMatchObject({organization_id:ORG,site_id:SITE,version_id:'main',blocking:false,counts:{hardcoded_size:1}});
    expect((await callRoute(auditEndpoint,'GET',`http://localhost/api/v1/sites/${SITE}/design-token-audit`,{siteId:SITE})).status).not.toBe(200);
    expect((await callRoute(auditEndpoint,'GET','http://localhost/api/v1/sites/other/design-token-audit',{siteId:'other'},{headers:bearer(token)})).status).not.toBe(200);
  });

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

  it('PATCH validates and trims cookie_consent.labels', async () => {
    const { token } = await setup();
    const { vstore } = await import('../../lib/version-store');
    const patch = (cookie_consent: unknown) => callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token), body: { cookie_consent } },
    );
    expect((await patch({ labels: { title: 'x', button: 'y' } })).status).toBe(400);
    expect((await patch({ labels: { reject: 5 } })).status).toBe(400);
    expect((await patch({ labels: { title: 'x'.repeat(121) } })).status).toBe(400);
    const res = await patch({ enabled: true, labels: { title: '  Cookies auf dieser Website ', reject: '' } });
    expect(res.status).toBe(200);
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect(settings?.cookie_consent?.labels).toEqual({ title: 'Cookies auf dieser Website' });
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

  const index = () => import('../../pages/api/v1/sites/[siteId]/redirects/index');
  const single = () => import('../../pages/api/v1/sites/[siteId]/redirects/[redirectId]');
  const url = `http://localhost/api/v1/sites/${SITE}/redirects`;
  async function rules(token: string) {
    const res = await callRoute(index(), 'GET', url, { siteId: SITE }, { headers: bearer(token) });
    return (await res.json() as { redirects: Array<{ id: string; from_path: string; to_path: string; status_code: number }> }).redirects;
  }

  it('POST with an existing from_path updates that rule in place', async () => {
    const { token } = await setup();
    await callRoute(index(), 'POST', url, { siteId: SITE }, { headers: bearer(token), body: { from_path: '/old', to_path: '/a' } });
    const second = await callRoute(index(), 'POST', url, { siteId: SITE }, { headers: bearer(token), body: { from_path: '/old', to_path: '/b', status_code: 302 } });
    expect(second.status).toBe(201);
    expect(await rules(token)).toEqual([expect.objectContaining({ from_path: '/old', to_path: '/b', status_code: 302 })]);
  });

  it('PATCH changes target and status but keeps id and source path', async () => {
    const { token } = await setup();
    const created = await (await callRoute(index(), 'POST', url, { siteId: SITE }, { headers: bearer(token), body: { from_path: '/wp-content/uploads/a.jpg', to_path: '/media/old-a.jpg' } })).json() as { redirect: { id: string } };
    const id = created.redirect.id;
    const patch = await callRoute(single(), 'PATCH', `${url}/${id}`, { siteId: SITE, redirectId: id }, { headers: bearer(token), body: { to_path: '/media/0123456789abcdef-a.jpg' } });
    expect(patch.status).toBe(200);
    expect(await rules(token)).toEqual([{ id, from_path: '/wp-content/uploads/a.jpg', to_path: '/media/0123456789abcdef-a.jpg', status_code: 301, auto_generated: false }]);

    const moved = await callRoute(single(), 'PATCH', `${url}/${id}`, { siteId: SITE, redirectId: id }, { headers: bearer(token), body: { from_path: '/elsewhere' } });
    expect(moved.status).toBe(400);
    const badStatus = await callRoute(single(), 'PATCH', `${url}/${id}`, { siteId: SITE, redirectId: id }, { headers: bearer(token), body: { status_code: 308 } });
    expect(badStatus.status).toBe(400);
    const missing = await callRoute(single(), 'PATCH', `${url}/nope`, { siteId: SITE, redirectId: 'nope' }, { headers: bearer(token), body: { to_path: '/x' } });
    expect(missing.status).toBe(404);
    const loop = await callRoute(index(), 'POST', url, { siteId: SITE }, { headers: bearer(token), body: { from_path: '/media/0123456789abcdef-a.jpg', to_path: '/c' } });
    expect(loop.status).toBe(201);
    const closesLoop = await callRoute(single(), 'PATCH', `${url}/${id}`, { siteId: SITE, redirectId: id }, { headers: bearer(token), body: { to_path: '/wp-content/uploads/a.jpg' } });
    expect(closesLoop.status).toBe(400);
  });

  it('PUT dry run reports per-rule actions and writes nothing', async () => {
    const { token } = await setup();
    await callRoute(index(), 'POST', url, { siteId: SITE }, { headers: bearer(token), body: { from_path: '/a', to_path: '/x' } });
    await callRoute(index(), 'POST', url, { siteId: SITE }, { headers: bearer(token), body: { from_path: '/b', to_path: '/y' } });
    const before = await rules(token);
    const res = await callRoute(index(), 'PUT', url, { siteId: SITE }, { headers: bearer(token), body: { dry_run: true, redirects: [
      { from_path: '/a', to_path: '/x2' }, { from_path: '/b', to_path: '/y' }, { from_path: '/c', to_path: '/z' },
    ] } });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: boolean; summary: Record<string, number>; results: Array<{ action: string; ok: boolean }> };
    expect(body.applied).toBe(false);
    expect(body.summary).toEqual({ create: 1, update: 1, unchanged: 1, failed: 0 });
    expect(body.results.map((result) => result.action)).toEqual(['update', 'unchanged', 'create']);
    expect(await rules(token)).toEqual(before);
  });

  it('PUT reports Cloudflare Pages redirect capacity before publishing would fail', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    const { paths } = await import('@typeroll/shared');
    const small = await callRoute(index(), 'PUT', url, { siteId: SITE }, { headers: bearer(token), body: { dry_run: true, redirects: [{ from_path: '/old', to_path: '/new' }] } });
    expect((await small.json() as any).capacity).toMatchObject({ limit_static: 2000, over_limit: false });
    for (let start = 0; start < 1900; start += 100) await Promise.all(Array.from({ length: 100 }, (_, i) => getStore().setDoc(`${paths.redirects(ORG, SITE, 'main')}/r${start + i}`, { from_path: `/wp-content/uploads/${start + i}.jpg`, to_path: '/media/a.jpg', status_code: 301 })));
    const res = await callRoute(index(), 'PUT', url, { siteId: SITE }, { headers: bearer(token), body: { dry_run: true, redirects:
      Array.from({ length: 200 }, (_, i) => ({ from_path: `/wp-content/uploads/new-${i}.jpg`, to_path: '/media/a.jpg' })) } });
    const body = await res.json() as any;
    expect(body.capacity).toMatchObject({ static: 2100, over_limit: true });
    expect(body.capacity.warning).toContain('publication_redirect_limit');
  });

  it('PUT applies many updates in place and keeps every id', async () => {
    const { token } = await setup();
    for (let i = 0; i < 30; i++)
      await callRoute(index(), 'POST', url, { siteId: SITE }, { headers: bearer(token), body: { from_path: `/wp-content/uploads/${i}.jpg`, to_path: `/media/wp-content/${i}.jpg` } });
    const before = await rules(token);
    const res = await callRoute(index(), 'PUT', url, { siteId: SITE }, { headers: bearer(token), body: { redirects:
      before.map((rule) => ({ from_path: rule.from_path, to_path: rule.to_path.replace('/media/wp-content/', '/media/0123456789abcdef-') })) } });
    expect(res.status).toBe(200);
    expect((await res.json() as { summary: Record<string, number> }).summary).toMatchObject({ update: 30, failed: 0 });
    const after = await rules(token);
    expect(after.map((rule) => rule.id).sort()).toEqual(before.map((rule) => rule.id).sort());
    expect(after.every((rule) => rule.to_path.startsWith('/media/0123456789abcdef-'))).toBe(true);
  });

  it('PUT writes nothing when any rule fails, including a loop formed inside the batch', async () => {
    const { token } = await setup();
    await seedPage('live', { slug: 'live' });
    const res = await callRoute(index(), 'PUT', url, { siteId: SITE }, { headers: bearer(token), body: { redirects: [
      { from_path: '/one', to_path: '/two' }, { from_path: '/two', to_path: '/one' }, { from_path: '/fine', to_path: '/ok' }, { from_path: '/live', to_path: '/x' },
    ] } });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; summary: { failed: number }; results: Array<{ from_path: string; ok: boolean }> };
    expect(body.error).toContain('nothing was written');
    expect(body.results.filter((result) => !result.ok).map((result) => result.from_path)).toEqual(['/one', '/two', '/live']);
    expect(await rules(token)).toEqual([]);
    const repeated = await callRoute(index(), 'PUT', url, { siteId: SITE }, { headers: bearer(token), body: { redirects: [
      { from_path: '/a', to_path: '/b' }, { from_path: '/a', to_path: '/c' },
    ] } });
    expect(repeated.status).toBe(400);
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
