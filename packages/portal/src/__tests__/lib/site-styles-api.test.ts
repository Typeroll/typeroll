// The style library over the v1 API: validated, contrast-checked writes,
// per-property merges, standard styles, and the rendered result.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, STANDARD_STYLES } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion, SiteSettings } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
let token = '';

async function setup(settings: Partial<SiteSettings> = {}): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), {
    site_name: 'S', colors: { primary: '#1d4ed8', secondary: '#1e293b', accent: '#f59e0b', background: '#ffffff', surface: '#f8fafc', text: '#0f172a', text_light: '#64748b' }, ...settings,
  });
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    title: 'Home', slug: 'home', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'h', type: 'core/heading', data: { text: 'Hello', level: 'h2', style_id: 'eyebrow' } }],
  });
  const { createApiKey } = await import('../../lib/api-keys');
  token = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' })).token;
}

async function call(route: string, method: string, url: string, params: Record<string, string> = {}, body?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/styles/${route}`)) as Partial<Record<string, APIRoute>>;
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/styles${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request: req, params: { siteId: SITE, ...params }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const eyebrow = { id: 'eyebrow', name: 'Överrubrik', targets: ['text', 'heading'], base: { size: '0.8125rem', weight: 700, transform: 'uppercase', color: 'primary' } };

describe('style library API', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('creates, lists, reads and renders a style', async () => {
    await setup();
    expect((await call('index', 'POST', '', {}, eyebrow)).status).toBe(201);
    expect((await call('index', 'POST', '', {}, eyebrow)).status).toBe(409);
    const list = await (await call('index', 'GET', '')).json() as { styles: { id: string }[]; missing_standard_roles: string[]; problems: string[] };
    expect(list.styles.map(s => s.id)).toEqual(['eyebrow']);
    expect(list.missing_standard_roles).toContain('h1');
    expect(list.problems).toEqual([]);
    expect((await call('[styleId]', 'GET', '/eyebrow', { styleId: 'eyebrow' })).status).toBe(200);

    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
    expect(html).toMatch(/<h2 class="block-heading-text s-eyebrow"[^>]*>Hello<\/h2>/);
    expect(html).toMatch(/<style data-site-styles="1">[^<]*\.s-eyebrow:not\(#\\#\)\{font-size:0\.8125rem/);
  });

  it('refuses invalid values and text that fails contrast', async () => {
    await setup();
    const bad = await call('index', 'POST', '', {}, { ...eyebrow, base: { size: '1px;}' } });
    expect(bad.status).toBe(400);
    const grey = await call('index', 'POST', '', {}, { ...eyebrow, id: 'grey', base: { color: '#cccccc' } });
    expect(grey.status).toBe(400);
    expect(((await grey.json()) as { errors: string[] }).errors.join()).toMatch(/contrast/);
  });

  it('merges updates per property and per breakpoint', async () => {
    await setup();
    await call('index', 'POST', '', {}, { ...eyebrow, at: { desktop: { size: '0.9rem' } } });
    const res = await call('[styleId]', 'PATCH', '/eyebrow', { styleId: 'eyebrow' }, { base: { weight: 800, transform: null }, at: { tablet: { size: '0.85rem' } } });
    expect(res.status).toBe(200);
    const { style } = await res.json() as { style: { base: Record<string, unknown>; at: Record<string, unknown> } };
    expect(style.base).toEqual({ size: '0.8125rem', weight: 800, color: 'primary' });
    expect(style.at).toEqual({ desktop: { size: '0.9rem' }, tablet: { size: '0.85rem' } });
    expect((await call('[styleId]', 'PATCH', '/eyebrow', { styleId: 'eyebrow' }, { id: 'renamed' })).status).toBe(400);
    expect((await call('[styleId]', 'DELETE', '/eyebrow', { styleId: 'eyebrow' })).status).toBe(200);
    expect((await call('[styleId]', 'DELETE', '/eyebrow', { styleId: 'eyebrow' })).status).toBe(404);
  });

  it('adds missing standard styles without touching the author\'s own', async () => {
    await setup({ styles: [{ ...eyebrow, role: 'eyebrow' } as never] });
    const res = await (await call('standard', 'POST', '/standard', {}, {})).json() as { added: string[]; replaced: string[] };
    expect(res.added).toHaveLength(STANDARD_STYLES.length - 1);
    expect(res.added).not.toContain('eyebrow');
    const again = await (await call('standard', 'POST', '/standard', {}, {})).json() as { added: string[] };
    expect(again.added).toEqual([]);
    const reset = await (await call('standard', 'POST', '/standard', {}, { overwrite: true })).json() as { replaced: string[] };
    expect(reset.replaced).toContain('eyebrow');
  });
});
