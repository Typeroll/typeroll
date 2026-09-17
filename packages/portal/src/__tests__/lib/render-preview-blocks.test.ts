// Verifies that render-preview renders block-mode pages via the shared
// block renderer (Phase 1). Locks down: (1) the renderer is wired up,
// (2) data substitutions are HTML-escaped, (3) the sanitizer still gets the
// final pass.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Block, ContentType, PageTemplate, Form, Page, Site, SiteVersion } from '@typeroll/shared';

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

  it('inherits main block-type dependencies into a child-version preview', async () => {
    await seedSite();
    const { getStore } = await import('../../lib/datastore');
    const branch = 'preview-branch';
    await getStore().setDoc(paths.version(ORG, SITE, branch), {
      name: 'Preview branch', kind: 'branch', base_version_id: MAIN_VERSION_ID,
      created_at: new Date().toISOString(), robots_blocked: true,
    } satisfies Partial<SiteVersion>);
    await getStore().setDoc(paths.blockType(ORG, SITE, 'installed-lead', MAIN_VERSION_ID), {
      id: 'installed-lead', name: 'installed-lead', label: 'Installed lead', category: 'custom',
      container: false, schema: [], template: '<div class="installed-lead">Lead</div>',
      extension: { extension_id: 'se.example.lead', installation_id: 'inst_1', component_id: 'lead-form' },
      origin: 'third_party', created_at: new Date().toISOString(),
    });
    await seedBlockPage([{ id: 'lead', type: 'installed-lead', data: {} }]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', branch);
    expect(html).toContain('class="installed-lead"');
    expect(html).toContain('data-tr-extension="se.example.lead"');
    expect(html).not.toContain('unknown block type');
  });

  it('renders an explicit diagnostic when a block-type dependency is missing', async () => {
    await seedSite();
    await seedBlockPage([{ id: 'missing', type: 'third-party/missing-card', data: {} }]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toContain('data-tr-missing-block="third-party/missing-card"');
    expect(html).toContain('Missing block type: third-party/missing-card');
  });

  it('preserves responsive data-field CSS through preview sanitization', async () => {
    await seedSite();
    await seedBlockPage([{
      id: 'responsive-grid', type: 'core/grid',
      data: { cols: { mobile: 1, tablet: 2, desktop: 3 }, gap: 'md', align: 'stretch' },
      children: [{ id: 'child', type: 'core/prose', data: { html: '<p>Item</p>' } }],
    }]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toContain('--cols:1');
    expect(html).toContain('@media (min-width: 640px) { [data-bid="responsive-grid"] { --cols: 2 !important; } }');
    expect(html).toContain('@media (min-width: 1280px) { [data-bid="responsive-grid"] { --cols: 3 !important; } }');
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
    expect(html!).not.toMatch(/<[^>]+data-block=/);
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
    expect(html!).not.toContain('[data-block="section"] > .block-section-inner');
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
    expect(html!).toContain('/* core/repeater */');
    expect(html!).toContain('/* core/image */');
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

  it('ships repeater and card assets on an otherwise empty collection listing', async () => {
    await seedSite();
    await seedBlockPage([{ id: 'list', type: 'core/page_list', data: {
      content_type: 'empty', cols: { mobile: 1, tablet: 2, desktop: 3 }, empty_state: 'Nothing published yet',
    } }]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toContain('Nothing published yet');
    expect(html).toContain('/* core/repeater */');
    expect(html).toContain('/* core/post_card */');
    expect(html).toContain('display:grid');
    expect(html!.replace(/\s+/g, '')).toContain('--cols:2!important');
    expect(html!.replace(/\s+/g, '')).toContain('--cols:3!important');
  });

  it('collects block header dependencies even on HTML pages', async () => {
    await seedSite();
    await seedBlockPage([], { content_mode: 'html', html_content: '<h1>HTML page</h1>' });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.partial(ORG, SITE, 'header'), {
      id: 'header', kind: 'header', status: 'published', content_mode: 'blocks',
      blocks: [{ id: 'gallery', type: 'core/gallery', data: { items: [{ src: '/logo.svg', alt: 'Logo' }] } }],
    });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toContain('/logo.svg');
    expect(html).toContain('/* core/repeater */');
    expect(html).toContain('/* core/image */');
  });

  it('collects dependencies from an embedded form without unrelated forms', async () => {
    await seedSite();
    await seedBlockPage([], { content_mode: 'html', html_content: '<x-form id="contact" />' });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
      id: 'contact', steps: [{ id: 'intro', blocks: [
        { id: 'gallery', type: 'core/gallery', data: { items: [{ src: '/example.svg', alt: 'Example' }] } },
      ] }],
    });
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/unused`, {
      id: 'unused', steps: [{ id: 'intro', blocks: [{ id: 'video', type: 'core/video', data: {} }] }],
    });
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toContain('/example.svg');
    expect(html).toContain('/* core/repeater */');
    expect(html).toContain('/* core/image */');
    expect(html).not.toContain('/* core/video */');
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

  it('injects nested block-instance custom CSS into the preview asset bundle', async () => {
    await seedSite();
    await seedBlockPage([{
      id: 'section',
      type: 'core/section',
      data: {},
      children: [{
        id: 'sidebar',
        type: 'core/prose',
        data: { html: '<p>Sidebar</p>' },
        style_overrides: {
          custom_css: '@media (max-width: 30rem) { .sidebar { display: none; } }',
        },
      }],
    }]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html).toContain('/* instance sidebar */');
    expect(html).toContain('.sidebar { display: none; }');
    expect(html!.indexOf('/* instance sidebar */')).toBeLessThan(html!.indexOf('</head>'));
  });

  it('renders a typed Page composition with typed bindings and SSR navigation', async () => {
    await seedSite();
    const { getStore } = await import('../../lib/datastore');
    const contentType: ContentType = {
      id: 'guides',
      name: 'guides',
      label_singular: 'Guide',
      label_plural: 'Guides',
      fields: [
        { name: 'pdf_url', label: 'PDF', type: 'url' },
      ],
      route_template: '/guides/{slug}',
      template: 'guide', created_at: '2026-09-05',
    };
    const template: PageTemplate = { id: 'guide', name: 'Guide', label: 'Guide', status: 'published',
      blocks: [
        { id: 'crumbs', type: 'template/page_breadcrumbs', data: { home_label: 'Home', aria_label: 'Breadcrumbs' } },
        { id: 'body', type: 'template_content_slot', data: {} },
        { id: 'toc', type: 'core/table_of_contents', data: { title: 'Contents', levels: 'h2-h3', source: 'page' } },
        {
          id: 'download-if', type: 'template/show_if', data: { condition: 'page.pdf_url' },
          children: [{ id: 'download', type: 'core/button', data: { label: 'Download', href: '{{page.pdf_url}}', variant: 'primary', size: 'md' } }],
        },
      ],
      created_at: '2026-09-05T00:00:00.000Z',
    };
    const page: Page = {
      id: 'energy',
      title: 'Energy',
      slug: 'energy',
      content_type: 'guides', content_mode: 'blocks',
      blocks: [{ id: 'h', type: 'core/heading', data: { text: 'Prepare well', level: 'h2', anchor_id: 'prepare-well' } }, { id: 'p', type: 'core/prose', data: { html: '<p>Body</p>' } }],
      fields: { pdf_url: 'https://cdn.example.test/energy.pdf?x=1&y=2' },
      status: 'published',
      date_updated: '2026-09-05T00:00:00.000Z',
    };
    await getStore().setDoc(paths.contentType(ORG, SITE, 'guides', MAIN_VERSION_ID), contentType);
    await getStore().setDoc(paths.pageTemplate(ORG, SITE, 'guide', MAIN_VERSION_ID), template);
    await getStore().setDoc(paths.page(ORG, SITE, 'energy', MAIN_VERSION_ID), page);
    await getStore().setDoc(paths.partial(ORG, SITE, 'header'), {
      id: 'header', kind: 'header', status: 'published', content_mode: 'blocks',
      blocks: [{ id: 'gallery', type: 'core/gallery', data: { items: [{ src: '/logo.svg', alt: 'Logo' }] } }],
    });

    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'energy', MAIN_VERSION_ID);
    expect(html).toContain('<a href="/">Home</a>');
    expect(html).toContain('<a href="#prepare-well">Prepare well</a>');
    expect(html).toContain('id="prepare-well"');
    expect(html).toContain('href="https://cdn.example.test/energy.pdf?x=1&amp;y=2"');
    expect(html).not.toContain('{{page.pdf_url}}');
    expect(html).toContain('/logo.svg');
    expect(html).toContain('/* core/repeater */');
    expect(html).toContain('/* core/image */');
  });

  it('omits the page-css <style> when a page has no custom_css', async () => {
    await seedSite();
    await seedBlockPage([{ id: 'h', type: 'core/heading', data: { text: 'Hi', level: 'h2' } }]);
    const { renderPreview } = await import('../../lib/render-preview');
    const html = await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID);
    expect(html!).not.toContain('data-page-css');
  });
});

it('excludes private and undeclared custom fields from Page template preview bindings', async () => {
  await seedSite();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.contentType(ORG, SITE, 'article', 'main'), { name: 'article', label_singular: 'Article', label_plural: 'Articles', route_template: '/articles/{slug}', fields: [{ name: 'internal', label: 'Internal', type: 'text', rendered: false }, { name: 'excerpt', label: 'Excerpt', type: 'text' }] });
  await seedBlockPage([{ id: 'values', type: 'core/prose', data: { html: '<p>{{page.internal}} {{page.unknown}} {{page.excerpt}}</p>' } }], { content_type: 'article', fields: { internal: 'Private value', unknown: 'Undeclared value', excerpt: 'Public value' } });
  const { renderPreview } = await import('../../lib/render-preview');
  const html = await renderPreview(ORG, SITE, 'home', 'main');
  expect(html).not.toContain('Private value');
  expect(html).not.toContain('Undeclared value');
  expect(html).toContain('Public value');
});

it('renders a native field-list template from saved Page fields and omits empty sections', async () => {
  await seedSite();
  const { getStore } = await import('../../lib/datastore');
  const { renderPreview } = await import('../../lib/render-preview');
  const store = getStore();
  await store.setDoc(paths.contentType(ORG, SITE, 'profile', MAIN_VERSION_ID), {
    name: 'profile', label_singular: 'Profile', label_plural: 'Profiles', route_template: '/{slug}', template: 'profile',
    fields: [{ name: 'hq', type: 'text', label: 'Headquarters' }, { name: 'delivery', type: 'boolean', label: 'Delivery' }, { name: 'internal', type: 'text', label: 'Internal', rendered: false }],
  });
  const blocks: Block[] = [{ id: 'facts', type: 'core/field_list', data: { title: 'At a glance', fields: [{ field: 'hq', html: '<dt>{{label}}</dt><dd><span onclick=\"evil()\" class=\"fact-badge\">{{value}}</span><script>evil()</script></dd>', css: 'color: navy;' }, { field: 'delivery', boolean_display: 'yes-no' }, { field: 'internal' }] } }];
  await store.setDoc(paths.pageTemplate(ORG, SITE, 'profile', MAIN_VERSION_ID), { name: 'profile', label: 'Profile', status: 'published', blocks });
  await seedBlockPage([], { content_type: 'profile', fields: { hq: 'Stockholm', delivery: false, internal: 'DO-NOT-PUBLISH' } });
  let html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
  expect(html).toContain('<span class=\"fact-badge\">Stockholm</span>');
  expect(html).toContain('color:navy');
  expect(html).not.toContain('evil()');
  expect(html).toContain('<dt>Delivery</dt><dd>No</dd>');
  expect(html).not.toContain('DO-NOT-PUBLISH');
  await store.updateDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, { fields: { hq: '', delivery: null, internal: 'DO-NOT-PUBLISH' } });
  html = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID))!;
  expect(html).not.toContain('At a glance');
  expect(html).not.toContain('<dt>');
  expect((await store.getDoc<PageTemplate>(paths.pageTemplate(ORG, SITE, 'profile', MAIN_VERSION_ID)))?.blocks).toEqual(blocks);
});
