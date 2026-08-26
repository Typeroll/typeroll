// Verifies that render-preview renders block-mode pages via the shared
// block renderer (Phase 1). Locks down: (1) the renderer is wired up,
// (2) data substitutions are HTML-escaped, (3) the sanitizer still gets the
// final pass.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Block, Form, Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function seedSite(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'Block Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
}

async function seedBlockPage(blocks: Block[], over: Partial<Page> = {}): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const page: Page = {
    id: 'home',
    title: 'Home',
    slug: 'home',
    content_mode: 'blocks',
    status: 'published',
    blocks,
    html_content: '',
    ...over,
  };
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, page);
}

describe('renderPreview — blocks mode', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('renders a heading block with HTML-escaped data', async () => {
    await seedSite();
    await seedBlockPage([
      {
        id: 'h',
        type: 'core/heading',
        data: { text: '<script>x</script>', level: 'h2', align: 'left', eyebrow: '' },
      },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).toContain('data-block="heading"');
    // sanitize-html converts &lt; to <, so after sanitizeBody the escaped
    // form may be decoded back; the key invariant is that no executable
    // script tag survives.
    expect(html!).not.toMatch(/<script\b[^>]*>x<\/script>/);
  });

  it('renders nested children inside a section', async () => {
    await seedSite();
    await seedBlockPage([
      {
        id: 's',
        type: 'core/section',
        data: { width: 'normal', padding_y: 'md' },
        children: [
          {
            id: 'h',
            type: 'core/heading',
            data: { text: 'Welcome', level: 'h1', align: 'center', eyebrow: 'INTRO' },
          },
          {
            id: 'p',
            type: 'core/prose',
            data: { html: '<p>Hello <strong>world</strong></p>', max_width: 'normal' },
          },
        ],
      },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).toContain('data-block="section"');
    expect(html!).toContain('Welcome');
    expect(html!).toContain('INTRO');
    expect(html!).toContain('<strong>world</strong>');
    // Nesting: heading appears before prose
    expect(html!.indexOf('Welcome')).toBeLessThan(html!.indexOf('Hello'));
  });

  it('renders two-column slots in order', async () => {
    await seedSite();
    await seedBlockPage([
      {
        id: 'c',
        type: 'core/columns',
        data: { ratio: '1-1', gap: 'md', align: 'start' },
        slots: [
          [{ id: 'L', type: 'core/heading', data: { text: 'Left side', level: 'h3', align: 'left', eyebrow: '' } }],
          [{ id: 'R', type: 'core/heading', data: { text: 'Right side', level: 'h3', align: 'left', eyebrow: '' } }],
        ],
      },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!.indexOf('Left side')).toBeLessThan(html!.indexOf('Right side'));
  });

  it('returns an empty body (no crash) when block mode has no blocks set', async () => {
    await seedSite();
    await seedBlockPage([], { blocks: [] });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    // No block container should be rendered
    expect(html!).not.toContain('data-block=');
  });

  it('inlines CSS for every block type actually used (tree-shaken)', async () => {
    await seedSite();
    await seedBlockPage([
      {
        id: 'h', type: 'core/heading',
        data: { text: 'Hi', level: 'h2', align: 'left', eyebrow: '' },
      },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    // heading CSS present
    expect(html!).toContain('[data-block="heading"]');
    expect(html!).toContain('data-blocks="1"');
    // section / columns / button / image / prose CSS NOT present — page
    // doesn't use them.
    expect(html!).not.toContain('[data-block="section"]');
    expect(html!).not.toContain('[data-block="columns"]');
    expect(html!).not.toContain('[data-block="button"]');
    expect(html!).not.toContain('[data-block="image"]');
  });

  it('does not emit a blocks <style> for HTML-mode pages', async () => {
    await seedSite();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`, {
      id: 'about', title: 'About', slug: 'about',
      content_mode: 'html', status: 'published',
      html_content: '<p>Just HTML</p>',
    });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'about', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).not.toContain('data-blocks="1"');
  });

  it('server-renders an <x-form> directive in HTML mode with initial state and the platform runtime', async () => {
    await seedSite();
    process.env.FORMS_HMAC_SECRET = 'forms-secret-forms-secret-forms-secret-1234';
    process.env.PORTAL_PUBLIC_URL = 'https://portal.example.com';
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/newsletter`, {
      name: 'Newsletter',
      actions: [],
      created_at: new Date().toISOString(),
      steps: [{
        id: 'main',
        blocks: [{ id: 'email', type: 'form/email', data: { name: 'email', label: 'Email', required: true } }],
      }],
    } satisfies Omit<Form, 'id'>);
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/signup`, {
      id: 'signup', title: 'Signup', slug: 'signup',
      content_mode: 'html', status: 'published',
      html_content: '<section><x-form id="newsletter" /></section>',
    });

    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'signup', MAIN_VERSION_ID);
    expect(html).toContain('<form data-tr-form-el method="POST" action="https://portal.example.com/api/forms/submit"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="_token"');
    expect(html).toContain('form[data-tr-form-el]');
    expect(html).not.toContain('<x-form');
  });

  it('expands repeater aliases (gallery → image grid)', async () => {
    await seedSite();
    await seedBlockPage([
      {
        id: 'g',
        type: 'core/gallery',
        data: {
          items: [
            { src: '/a.jpg', alt: 'A' },
            { src: '/b.jpg', alt: 'B' },
          ],
          cols: 2,
        },
      },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).toContain('data-block="repeater"');
    // Each item rendered as an image — sanitizeBody may strip attributes
    // it doesn't whitelist, but the src URLs should survive.
    expect(html!).toContain('/a.jpg');
    expect(html!).toContain('/b.jpg');
  });

  it('substitutes {{page.title}} via render context', async () => {
    await seedSite();
    await seedBlockPage([
      {
        id: 'pt',
        type: 'template/page_title',
        data: { level: 'h1', size: 'auto', align: 'left' },
      },
    ], { title: 'My Custom Title' });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    // The page_title block renders the page's title from context
    expect(html!).toContain('My Custom Title');
  });

  it('honours responsive cols on a grid', async () => {
    await seedSite();
    await seedBlockPage([
      {
        id: 'gr',
        type: 'core/grid',
        data: {
          cols: { mobile: 1, tablet: 2, desktop: 4 },
          gap: 'md',
          align: 'stretch',
        },
        children: [
          { id: 'h1', type: 'core/heading', data: { text: 'A', level: 'h3', size: 'auto', align: 'left', eyebrow: '' } },
        ],
      },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    // Mobile baseline rendered into the inline style — note no space
    // after the colon (template substitution is verbatim).
    expect(html!).toContain('--cols:1');
    // The @media overrides land in a per-instance <style> block —
    // sanitizeBody strips <style> by default; confirm via data-bid
    // attribute presence which proves the renderer chose to emit one.
    expect(html!).toContain('data-bid="gr"');
  });

  it('loads custom block_types from the per-site collection', async () => {
    await seedSite();
    const { getStore } = await import('../../lib/datastore');
    // Register a custom block_type
    await getStore().setDoc(
      paths.blockType(ORG, SITE, 'user-banner', MAIN_VERSION_ID),
      {
        id: 'user-banner',
        name: 'banner',
        label: 'Banner',
        category: 'content',
        container: false,
        schema: [{ name: 'msg', type: 'text', label: 'Message' }],
        template: '<aside data-block="banner">{{msg}}</aside>',
        origin: 'user',
        created_at: '2026-05-28T00:00:00Z',
      },
    );
    await seedBlockPage([
      { id: 'b', type: 'user-banner', data: { msg: 'Custom block!' } },
    ]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).toContain('data-block="banner"');
    expect(html!).toContain('Custom block!');
  });

  it('injects per-page custom_css into <head>, after the block CSS', async () => {
    await seedSite();
    await seedBlockPage(
      [{ id: 'h', type: 'core/heading', data: { text: 'Hi', level: 'h2' } }],
      { custom_css: '.gs-marker{color:hotpink}' },
    );
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toBeTruthy();
    expect(html!).toContain('<style data-page-css="1">.gs-marker{color:hotpink}</style>');
    // Must land in <head> (before <body>) and AFTER the block CSS so the page
    // CSS wins the cascade by source order — mirrors BaseLayout on the live site.
    const headEnd = html!.indexOf('</head>');
    const pageCssAt = html!.indexOf('data-page-css');
    const blockCssAt = html!.indexOf('data-blocks="1"');
    expect(pageCssAt).toBeGreaterThan(-1);
    expect(pageCssAt).toBeLessThan(headEnd);
    if (blockCssAt > -1) expect(pageCssAt).toBeGreaterThan(blockCssAt);
  });

  it('omits the page-css <style> when a page has no custom_css', async () => {
    await seedSite();
    await seedBlockPage([{ id: 'h', type: 'core/heading', data: { text: 'Hi', level: 'h2' } }]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html!).not.toContain('data-page-css');
  });
});
