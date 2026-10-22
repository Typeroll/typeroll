// Block part styles through the v1 API: a style applies to a block part
// site-wide, a block chooses its own style for a part, and both are checked
// against the site's styles and block types before anything is written.
// See docs/plans/block-parts.md.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, type Block, type Page, type Site, type SiteSettings, type SiteVersion } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const ORG = 'orgone';
const SITE = 'mysite';

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

const quietLink = { id: 'quiet-link', name: 'Quiet link', targets: ['link'], base: { decoration: 'none' }, hover: { decoration: 'underline' } };
const loudLink = { id: 'loud-link', name: 'Loud link', targets: ['link'], base: { weight: 700 } };
const paleText = { id: 'pale-text', name: 'Pale text', targets: ['text'], base: { color: '#f1f1f1' } };

async function setup(settings: Partial<SiteSettings> = {}, blocks: Block[] = []): Promise<string> {
  makeTmpFixtures();
  await resetDatastore();
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await s.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await s.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), {
    site_name: 'S', colors: { primary: '#1d4ed8', secondary: '#1e293b', accent: '#f59e0b', background: '#ffffff', surface: '#f8fafc', text: '#0f172a', text_light: '#475569' }, ...settings,
  });
  await s.setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    title: 'Home', slug: 'home', status: 'published', content_mode: 'blocks', blocks, html_content: '',
  } satisfies Partial<Page>);
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' })).token;
}

type Method = 'GET' | 'POST' | 'PATCH';
async function call(route: Promise<Partial<Record<Method, APIRoute>>>, method: Method, url: string, params: Record<string, string>, token: string, body?: unknown): Promise<Response> {
  const handler = (await route)[method]!;
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler({ request, params, cookies: { get: () => undefined } as never, locals: {} as never } as never) as Promise<Response>;
}

const blocksRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index');
const stylesRoute = () => import('../../pages/api/v1/sites/[siteId]/styles/index');
const blocksUrl = `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`;
const blocksParams = { siteId: SITE, pageId: 'home' };
const stylesUrl = `http://localhost/api/v1/sites/${SITE}/styles`;
const heading = (data: Record<string, unknown> = {}): Block => ({ id: 'rh', type: 'core/rich_heading', data: { level: 'h2', html: '<a href="/x/">Link</a>', ...data } });
const hero = (data: Record<string, unknown> = {}): Block => ({ id: 'hero', type: 'core/hero', data: { heading: 'Hello', eyebrow: 'New', ...data } });

async function draftBlocks(token: string): Promise<Block[]> {
  const res = await call(blocksRoute(), 'GET', blocksUrl, blocksParams, token);
  return ((await res.json()) as { blocks: Block[] }).blocks;
}

describe('block part styles over the v1 API', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('accepts a style for a block part site-wide and names unknown parts', async () => {
    const token = await setup();
    const created = await call(stylesRoute(), 'POST', stylesUrl, { siteId: SITE }, token, { ...quietLink, parts: ['core/rich_heading.link'] });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { style: { parts: string[] } }).style.parts).toEqual(['core/rich_heading.link']);

    const typo = await call(stylesRoute(), 'POST', stylesUrl, { siteId: SITE }, token, { ...loudLink, parts: ['core/rich_heading.lnk'] });
    expect(typo.status).toBe(400);
    expect(((await typo.json()) as { errors: string[] }).errors.join()).toContain('Did you mean core/rich_heading.link?');

    const kind = await call(stylesRoute(), 'POST', stylesUrl, { siteId: SITE }, token, { ...loudLink, parts: ['core/hero.heading'] });
    expect(kind.status).toBe(400);
    expect(((await kind.json()) as { errors: string[] }).errors.join()).toContain('Add "heading" to its targets');

    const twice = await call(stylesRoute(), 'POST', stylesUrl, { siteId: SITE }, token, { ...loudLink, parts: ['core/rich_heading.link'] });
    expect(twice.status).toBe(400);
    expect(((await twice.json()) as { errors: string[] }).errors.join()).toContain('a part takes one site-wide style');
  });

  it('refuses a site-wide part style whose text is unreadable on the part background', async () => {
    const token = await setup();
    // Light text without a background of its own is measured where each part
    // sits: the secondary button has the page background behind it.
    const light = { id: 'light-label', name: 'Light label', targets: ['button'], base: { color: '#ffffff', weight: 600 }, parts: ['core/hero.secondary_button'] };
    const res = await call(stylesRoute(), 'POST', stylesUrl, { siteId: SITE }, token, light);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: string[] }).errors.join()).toContain('on core/hero.secondary_button');
    const dark = await call(stylesRoute(), 'POST', stylesUrl, { siteId: SITE }, token, { ...light, id: 'dark-label', name: 'Dark label', base: { color: 'text', weight: 600 }, parts: ['core/hero.primary_button'] });
    // Dark text reads on the page but not on the primary button (#1d4ed8).
    expect(dark.status).toBe(400);
    expect(((await dark.json()) as { errors: string[] }).errors.join()).toContain('on core/hero.primary_button');
  });

  it('writes an instance part style, and rejects unknown parts and styles with suggestions', async () => {
    const token = await setup({ styles: [quietLink, loudLink] as SiteSettings['styles'] }, [heading()]);
    const part = await call(blocksRoute(), 'PATCH', blocksUrl, blocksParams, token, { block_id: 'rh', data: { part_styles: { lnk: 'loud-link' } } });
    expect(part.status).toBe(400);
    expect(await part.json()).toEqual(expect.objectContaining({ code: 'unknown_field', unknown_fields: [expect.objectContaining({ path: 'data.part_styles.lnk', suggestions: ['link'] })] }));

    const style = await call(blocksRoute(), 'PATCH', blocksUrl, blocksParams, token, { block_id: 'rh', data: { part_styles: { link: 'lowd-link' } } });
    expect(style.status).toBe(400);
    expect(await style.json()).toEqual(expect.objectContaining({ code: 'unknown_style', part_style_issues: [expect.objectContaining({ path: 'data.part_styles.link', suggestions: ['loud-link'] })] }));
    expect((await draftBlocks(token))[0]!.data.part_styles).toBeUndefined();

    const ok = await call(blocksRoute(), 'PATCH', blocksUrl, blocksParams, token, { block_id: 'rh', data: { part_styles: { link: 'loud-link' } } });
    expect(ok.status).toBe(200);
    expect((await draftBlocks(token))[0]!.data.part_styles).toEqual({ link: 'loud-link' });
  });

  it('measures an instance part style on the block background', async () => {
    const token = await setup({ styles: [paleText] as SiteSettings['styles'] }, [hero()]);
    const pale = await call(blocksRoute(), 'PATCH', blocksUrl, blocksParams, token, { block_id: 'hero', data: { part_styles: { eyebrow: 'pale-text' } } });
    expect(pale.status).toBe(400);
    expect(((await pale.json()) as { code: string }).code).toBe('part_style_contrast');
    const dark = await call(blocksRoute(), 'PATCH', blocksUrl, blocksParams, token, { block_id: 'hero', data: { background: '#111111', part_styles: { eyebrow: 'pale-text' } } });
    expect(dark.status).toBe(200);
    // add_block runs the same check.
    const added = await call(blocksRoute(), 'POST', blocksUrl, blocksParams, token, { block: { type: 'core/hero', data: { heading: 'Again', part_styles: { eyebrow: 'pale-text' } } } });
    expect(added.status).toBe(400);
  });

  it('renders site-wide and instance part styles in the preview', async () => {
    await setup({ styles: [{ ...quietLink, parts: ['core/rich_heading.link'] }, loudLink] as SiteSettings['styles'] }, [
      heading(), { ...heading({ part_styles: { link: 'loud-link' } }), id: 'rh2' },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
    expect(html.match(/<h2 [^>]*data-part-link="loud-link"/g)).toHaveLength(1);
    expect(html).toContain(':where([data-block="rich_heading"]:not([data-part-link]) a):not([class^="s-"],[class*=" s-"]):not(#\\#):not(#\\#){text-decoration:none}');
    expect(html).toContain(':where([data-block="rich_heading"][data-part-link="loud-link"] a)');
  });
});
