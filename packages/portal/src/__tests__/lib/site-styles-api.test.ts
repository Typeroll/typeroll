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

describe('palette changes', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('warns when a new palette makes an existing style unreadable', async () => {
    await setup();
    await call('index', 'POST', '', {}, eyebrow);
    const mod = (await import('../../pages/api/v1/sites/[siteId]/settings')) as Partial<Record<string, APIRoute>>;
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ colors: { primary: '#d4d4d8' } }) });
    const res = await mod.PATCH!({ request: req, params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as never) as Response;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings: string[] }).warnings.join()).toMatch(/Överrubrik.*contrast/);
  });
});

describe('text colour on theme colours', () => {
  beforeEach(async () => { await resetDatastore(); });

  const teal = { primary: '#00a19c', secondary: '#1e293b', accent: '#f59e0b', background: '#ffffff', surface: '#f8fafc', text: '#0f172a', text_light: '#64748b' };
  type SettingsResponse = { warnings?: string[]; on_colors?: Record<string, unknown>[] };

  async function patchSettings(body: unknown): Promise<Response> {
    const mod = (await import('../../pages/api/v1/sites/[siteId]/settings')) as Partial<Record<string, APIRoute>>;
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return mod.PATCH!({ request: req, params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
  }
  async function storedColors(): Promise<Record<string, string>> {
    const { vstore } = await import('../../lib/version-store');
    return (await vstore.settings(ORG, SITE, MAIN_VERSION_ID))?.colors as unknown as Record<string, string>;
  }

  it('validates, stores and clears an explicit on-colour', async () => {
    await setup();
    for (const bad of ['white', '#fff8', 'rgb(255,255,255)', 12, '#ffffff;}']) {
      const res = await patchSettings({ colors: { on_secondary: bad } });
      expect(res.status, String(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/colors\.on_secondary must be a hex colour/);
    }
    expect((await patchSettings({ colors: { primary: null } })).status).toBe(400);
    const res = await patchSettings({ colors: { secondary: '#00a19c', on_secondary: '#ffffff' } });
    expect(res.status).toBe(200);
    const body = await res.json() as SettingsResponse;
    expect(body.warnings).toBeUndefined();
    expect(body.on_colors?.find(item => item.token === 'on_secondary')).toEqual({ token: 'on_secondary', color: '#ffffff', background: '#00a19c', explicit: true, apca_lc: -63.9, wcag_ratio: 3.19, button_text_ok: true });
    expect((await storedColors()).on_secondary).toBe('#ffffff');
    expect((await storedColors()).primary).toBe('#1d4ed8');
    expect((await patchSettings({ colors: { on_secondary: null } })).status).toBe(200);
    expect(await storedColors()).not.toHaveProperty('on_secondary');
    expect((await storedColors()).secondary).toBe('#00a19c');
  });

  it('keeps a clearly unreadable choice and warns with both measures', async () => {
    await setup({ render_version: 8 });
    const res = await patchSettings({ colors: { secondary: '#00a19c', on_secondary: '#111827' } });
    expect(res.status).toBe(200);
    const body = await res.json() as SettingsResponse;
    expect(body.warnings).toEqual(['colors.on_secondary #111827 on secondary #00a19c is APCA Lc 44.0, WCAG 2 5.56:1, below APCA Lc 60 for 16px/600 non-body text such as buttons. The automatic choice would be #ffffff (APCA Lc 63.9, WCAG 2 3.19:1).']);
    expect((await storedColors()).on_secondary).toBe('#111827');
  });

  it('renders an explicit on-colour on every render version', async () => {
    const { renderPreview } = await import('../../lib/render-preview');
    for (const version of [1, 7, 8]) {
      await setup({ render_version: version, colors: { ...teal, on_primary: '#ffffff' } });
      const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
      expect(html, `version ${version}`).toContain('--color-on-primary:#ffffff');
      expect(html, `version ${version}`).toContain(':where(:root){--color-primary-fg:var(--color-on-primary)}');
    }
  });

  it('chooses the automatic on-colour by APCA from render version 8 only', async () => {
    const { renderPreview } = await import('../../lib/render-preview');
    await setup({ render_version: 7, colors: teal });
    expect(await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID)).toContain('--color-on-primary:#111827');
    await setup({ render_version: 8, colors: teal });
    expect(await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID)).toContain('--color-on-primary:#ffffff');
  });

  it('accepts a white 16px/600 button on #00a19c and reports a WCAG-only pass', async () => {
    const button = STANDARD_STYLES.find(style => style.role === 'button')!;
    await setup({ render_version: 7, colors: { ...teal, on_primary: '#ffffff' } });
    const white = await call('index', 'POST', '', {}, { ...button, id: 'cta' });
    expect(white.status).toBe(201);
    expect(await white.json()).not.toHaveProperty('warnings');
    // Version 7's automatic #111827 meets WCAG 2 AA (5.56:1) but not APCA Lc 60: saved, with a warning.
    await setup({ render_version: 7, colors: teal });
    const dark = await call('index', 'POST', '', {}, { ...button, id: 'cta' });
    expect(dark.status).toBe(201);
    expect(((await dark.json()) as { warnings: string[] }).warnings.join()).toMatch(/#111827 on #00a19c is APCA Lc 44\.0, WCAG 2 5\.56:1: below APCA Lc 60 .* Render version 8 chooses #ffffff for on_primary here; or set colors\.on_primary\./);
    const list = await (await call('index', 'GET', '')).json() as { problems: string[]; warnings: string[] };
    expect(list.problems).toEqual([]);
    expect(list.warnings).toHaveLength(1);
  });

  it('reports each standard style it adds with the body text colour', async () => {
    await setup({ colors: { ...teal, primary: '#fde047' } });
    const res = await (await call('standard', 'POST', '/standard', {}, {})).json() as { adjusted: string[]; warnings: string[]; styles: { id: string; base: { color?: string } }[] };
    expect(res.adjusted).toEqual(expect.arrayContaining(['link', 'eyebrow']));
    expect(res.styles.find(style => style.id === 'eyebrow')?.base.color).toBe('text');
    expect(res.warnings.find(note => note.startsWith('Eyebrow (base)'))).toMatch(/#fde047 on #ffffff is APCA Lc \d+\.\d, WCAG 2 1\.\d\d:1\. .* Added with the body text colour \(text, #0f172a\) instead of primary/);
  });
});
