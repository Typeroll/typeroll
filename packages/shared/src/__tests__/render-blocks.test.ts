import { describe, it, expect } from 'vitest';
import {
  renderBlocks,
  renderBlock,
  collectUsedBlockTypeIds,
  collectBlockAssets,
  composePageWithTemplate,
  fnv1aHex,
  escapeHtml,
  BLOCKS_RUNTIME_CSS,
} from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { Block, BlockType } from '../types.js';

const registry = buildCoreBlockRegistry();

describe('annotate — block provenance for agents', () => {
  const tree: Block[] = [
    {
      id: 'blk_sec',
      type: 'core/section',
      data: { background: '#fff' },
      children: [{ id: 'blk_h', type: 'core/heading', data: { text: 'Hej', level: 'h2' } }],
    },
  ];

  it('is off by default — no data-block-id leaks into production output', () => {
    const html = renderBlocks(tree, { registry });
    expect(html).not.toContain('data-block-id');
    expect(html).not.toContain('data-block-type');
  });

  it('annotate:true tags every block root with its authored id + type', () => {
    const html = renderBlocks(tree, { registry, annotate: true });
    expect(html).toContain('data-block-id="blk_sec"');
    expect(html).toContain('data-block-type="core/section"');
    expect(html).toContain('data-block-id="blk_h"');
    expect(html).toContain('data-block-type="core/heading"');
  });

  it('annotate:true tags a repeater root with its authored (alias) id + type', () => {
    // Repeater items render with synthetic ids; the root must still be
    // addressable so the editor canvas hit-test can target the whole block.
    const repeaterTree: Block[] = [{ id: 'blk_gal', type: 'core/gallery', data: {} }];
    const html = renderBlocks(repeaterTree, { registry, annotate: true });
    expect(html).toContain('data-block-id="blk_gal"');
    expect(html).toContain('data-block-type="core/gallery"');
  });
});

describe('escapeHtml', () => {
  it('escapes the standard set', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's & co")).toBe('it&#39;s &amp; co');
  });

  it('coerces null/undefined to empty', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('renderBlock — substitution', () => {
  it('HTML-escapes {{field}} values', () => {
    const html = renderBlock(
      {
        id: 'b1',
        type: 'core/heading',
        data: { text: '<img onerror=alert(1)>', level: 'h2', align: 'left', eyebrow: '' },
      },
      { registry },
    );
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
    expect(html).not.toContain('<img onerror');
  });

  it('passes {{{field}}} through raw (richtext escape hatch)', () => {
    const html = renderBlock(
      {
        id: 'b1',
        type: 'core/prose',
        data: { html: '<p><strong>hello</strong></p>', max_width: 'normal' },
      },
      { registry },
    );
    expect(html).toContain('<p><strong>hello</strong></p>');
  });

  it('renders {{children}} for container blocks', () => {
    const html = renderBlock(
      {
        id: 's1',
        type: 'core/section',
        data: { width: 'normal', padding_y: 'md' },
        children: [
          {
            id: 'h1',
            type: 'core/heading',
            data: { text: 'Hello', level: 'h2', align: 'left', eyebrow: '' },
          },
        ],
      },
      { registry },
    );
    expect(html).toContain('data-block="section"');
    expect(html).toContain('data-block="heading"');
    expect(html).toContain('>Hello<');
  });

  it('renders {{slot:NAME}} from named slots', () => {
    const html = renderBlock(
      {
        id: 'c1',
        type: 'core/columns',
        data: { ratio: '1-1', gap: 'md', align: 'start' },
        slots: [
          [{ id: 'L', type: 'core/heading', data: { text: 'Left', level: 'h2', align: 'left', eyebrow: '' } }],
          [{ id: 'R', type: 'core/heading', data: { text: 'Right', level: 'h2', align: 'left', eyebrow: '' } }],
        ],
      },
      { registry },
    );
    expect(html.indexOf('Left')).toBeLessThan(html.indexOf('Right'));
    expect(html).toContain('data-block="columns"');
  });

  it('resolves exact typed context bindings stored in text, URL, and image fields', () => {
    const button = renderBlock(
      {
        id: 'download',
        type: 'core/button',
        data: {
          label: '{{item.download_label}}',
          href: '{{item.pdf_url}}',
          variant: 'primary',
          size: 'md',
        },
      },
      {
        registry,
        context: {
          item: {
            download_label: 'Download & read',
            pdf_url: 'https://cdn.example.test/file.pdf?x=1&y=2',
          },
        },
      },
    );
    expect(button).toContain('href="https://cdn.example.test/file.pdf?x=1&amp;y=2"');
    expect(button).toContain('>Download &amp; read</a>');
    expect(button).not.toContain('{{item.');

    const image = renderBlock(
      {
        id: 'cover',
        type: 'core/image',
        data: { src: '{{item.cover}}', alt: '{{item.title}}', width: 'normal' },
      },
      { registry, context: { item: { cover: '/cover.webp', title: 'A & B' } } },
    );
    expect(image).toContain('src="/cover.webp"');
    expect(image).toContain('alt="A &amp; B"');
  });

  it('renders the selected collection item rich-text and image fields', () => {
    const context = {
      item: {
        title: 'Guide',
        body: '<p>Wrong body</p>',
        toc_html: '<h2 id="first">Selected body</h2><p>Copy</p>',
        image: '/wrong.jpg',
        hero: '/hero.jpg',
        reviewed_at: '2026-09-05',
      },
    };
    const body = renderBlock(
      { id: 'body', type: 'template/item_body', data: { field: 'toc_html', max_width: 'normal' } },
      { registry, context },
    );
    expect(body).toContain('Selected body');
    expect(body).not.toContain('Wrong body');

    const image = renderBlock(
      { id: 'image', type: 'template/item_image', data: { field: 'hero', width: 'wide' } },
      { registry, context },
    );
    expect(image).toContain('src="/hero.jpg"');
    expect(image).not.toContain('/wrong.jpg');

    const missing = renderBlock(
      { id: 'missing', type: 'template/item_body', data: { field: 'missing_body', max_width: 'normal' } },
      { registry, context },
    );
    expect(missing).toContain('data-block="prose"');
    expect(missing).not.toContain('Wrong body');
    expect(missing).not.toContain('Selected body');

    const date = renderBlock(
      { id: 'date', type: 'template/page_date', data: { field: 'reviewed_at' } },
      { registry, context },
    );
    expect(date).toContain('datetime="2026-09-05"');
    expect(date).toContain('>2026-09-05</time>');
  });

  it('materializes semantic breadcrumbs in the initial HTML', () => {
    const html = renderBlock(
      {
        id: 'crumbs',
        type: 'template/page_breadcrumbs',
        data: { home_label: 'Start', aria_label: 'Brödsmulor', separator: 'slash' },
      },
      {
        registry,
        context: {
          page: {
            breadcrumbs: [
              { label: 'Checklistor', href: '/flyttchecklistor/' },
              { label: 'Energi & miljö', href: '/kategori/energi/' },
              { label: 'Spara energi', href: '/flyttchecklistor/spara-energi/', current: true },
            ],
          },
        },
      },
    );
    expect(html).toContain('aria-label="Brödsmulor"');
    expect(html).toContain('<ol>');
    expect(html).toContain('<a href="/">Start</a>');
    expect(html).toContain('<a href="/flyttchecklistor/">Checklistor</a>');
    expect(html).toContain('aria-current="page">Spara energi</span>');
    expect(html).not.toContain('data-trail=');
  });

  it('renders a table of contents from a selected rich-text field before JavaScript', () => {
    const context = {
      item: {
        article_body: '<h2 id="packa">Packa &amp; skydda</h2><p>Text</p><h3>TV & skärm</h3><h3 id="packa">Dublett</h3>',
      },
    };
    const toc = renderBlock(
      {
        id: 'toc',
        type: 'core/table_of_contents',
        data: { title: 'Innehåll', levels: 'h2-h3', source_field: 'article_body' },
      },
      { registry, context },
    );
    expect(toc).toContain('<a href="#packa">Packa &amp; skydda</a>');
    expect(toc).toContain('<a href="#tv-skarm">TV &amp; skärm</a>');
    expect(toc).toContain('<a href="#packa-2">Dublett</a>');
    expect(toc).toContain('data-empty="false"');

    const body = renderBlock(
      { id: 'body', type: 'template/item_body', data: { field: 'article_body', max_width: 'normal' } },
      { registry, context },
    );
    expect(body).toContain('<h3 id="tv-skarm">TV & skärm</h3>');
    expect(body).toContain('<h3 id="packa-2">Dublett</h3>');
  });

  it('allows item navigation to override collection order with explicit fields', () => {
    const html = renderBlock(
      {
        id: 'nav',
        type: 'template/item_navigation',
        data: {
          previous_label: 'Föregående',
          next_label: 'Nästa',
          previous_url_field: 'prev_url',
          previous_title_field: 'prev_title',
          next_url_field: 'next_url',
          next_title_field: 'next_title',
        },
      },
      {
        registry,
        context: {
          item: {
            prev_url: '/forra/',
            prev_title: 'Förra checklistan',
            next_url: '',
            next_title: 'Must not remain focusable',
          },
          collection: {
            previous: { url: '/sorted-prev/', title: 'Sorted previous' },
            next: { url: '/sorted-next/', title: 'Sorted next' },
          },
        },
      },
    );
    expect(html).toContain('href="/forra/"');
    expect(html).toContain('Förra checklistan');
    expect(html).not.toContain('/sorted-prev/');
    expect(html).toContain('item-navigation-next" data-empty="true"');
    expect(html).not.toContain('href="/sorted-next/"');
  });
});

describe('renderBlock — tag substitution {{=field}}', () => {
  const tagRegistry: Record<string, BlockType> = {
    'test/wrapper': {
      id: 'test/wrapper',
      name: 'wrapper',
      label: 'Wrapper',
      category: 'content',
      container: false,
      schema: [{ name: 'tag', type: 'text', label: 'Tag' }],
      template: '<{{=tag}} class="wrap">hi</{{=tag}}>',
      origin: 'core',
      created_at: '2026-01-01T00:00:00Z',
    },
  };

  it('substitutes a known safe tag name', () => {
    const html = renderBlock(
      { id: 'b', type: 'test/wrapper', data: { tag: 'section' } },
      { registry: tagRegistry },
    );
    expect(html).toBe('<section class="wrap">hi</section>');
  });

  it('lowercases tag names', () => {
    const html = renderBlock(
      { id: 'b', type: 'test/wrapper', data: { tag: 'H1' } },
      { registry: tagRegistry },
    );
    expect(html).toBe('<h1 class="wrap">hi</h1>');
  });

  it('falls back to div for unknown tags', () => {
    const html = renderBlock(
      { id: 'b', type: 'test/wrapper', data: { tag: 'script' } },
      { registry: tagRegistry },
    );
    expect(html).toBe('<div class="wrap">hi</div>');
    expect(html).not.toContain('<script');
  });

  it('falls back to div for HTML-injection attempts', () => {
    const html = renderBlock(
      { id: 'b', type: 'test/wrapper', data: { tag: 'h1 onclick=alert(1)' } },
      { registry: tagRegistry },
    );
    // Space + attribute syntax means the value isn't in the allowlist
    expect(html).toBe('<div class="wrap">hi</div>');
    expect(html).not.toContain('onclick');
  });

  it('falls back to div for empty / missing tag value', () => {
    const html = renderBlock(
      { id: 'b', type: 'test/wrapper', data: {} },
      { registry: tagRegistry },
    );
    expect(html).toBe('<div class="wrap">hi</div>');
  });
});

describe('core/heading — fluid type + semantic level', () => {
  it('emits the requested semantic tag (h1 → <h1>, not <h2>)', () => {
    const html = renderBlock(
      {
        id: 'h',
        type: 'core/heading',
        data: { text: 'Big', level: 'h1', size: 'auto', align: 'left', eyebrow: '' },
      },
      { registry },
    );
    expect(html).toContain('<h1 class="block-heading-text">Big</h1>');
    expect(html).not.toContain('<h2 class="block-heading-text">');
  });

  it('supports h1..h6 levels', () => {
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      const html = renderBlock(
        {
          id: 'h',
          type: 'core/heading',
          data: { text: 'x', level, size: 'auto', align: 'left', eyebrow: '' },
        },
        { registry },
      );
      expect(html).toContain(`<${level} class="block-heading-text">x</${level}>`);
    }
  });

  it('falls back to div if level is invalid', () => {
    const html = renderBlock(
      {
        id: 'h',
        type: 'core/heading',
        data: { text: 'x', level: 'h7', size: 'auto', align: 'left', eyebrow: '' },
      },
      { registry },
    );
    // h7 is not in the allowlist, so the tag becomes div. text still renders.
    expect(html).toContain('<div class="block-heading-text">x</div>');
  });

  it('emits data-size for visual sizing decoupled from level', () => {
    const html = renderBlock(
      {
        id: 'h',
        type: 'core/heading',
        data: { text: 'small h1', level: 'h1', size: 'sm', align: 'left', eyebrow: '' },
      },
      { registry },
    );
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('data-level="h1"');
    expect(html).toContain('<h1 class="block-heading-text">');
  });

  it('ships fluid clamp() CSS for every size', () => {
    const css = registry.get('core/heading')?.styles ?? '';
    expect(css).toContain('clamp(');
    for (const size of ['sm', 'md', 'lg', 'xl', '2xl', '3xl']) {
      expect(css).toContain(`[data-size="${size}"]`);
    }
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(css).toContain(`[data-size="auto"][data-level="${level}"]`);
    }
  });
});

describe('core/prose — fluid type', () => {
  it('ships fluid clamp() CSS for body + nested headings', () => {
    const css = registry.get('core/prose')?.styles ?? '';
    expect(css).toContain('clamp(1rem');
    for (const h of ['h1', 'h2', 'h3', 'h4']) {
      expect(css).toMatch(new RegExp(`\\[data-block="prose"\\] ${h}.*clamp\\(`));
    }
  });
});

describe('renderBlock — responsive values', () => {
  // A test block with two responsive fields: one used as a CSS variable
  // (the convention for layout-sensitive values) and one as a normal
  // substitution. Tests cover mobile baseline, BP overrides, and that
  // non-responsive data passes through unchanged.
  const responsiveRegistry: Record<string, BlockType> = {
    'test/grid': {
      id: 'test/grid',
      name: 'grid',
      label: 'Grid',
      category: 'layout',
      container: true,
      schema: [
        { name: 'cols', type: 'select', label: 'Columns', responsive: true, default: 1 },
        { name: 'gap', type: 'select', label: 'Gap', responsive: true, default: 'sm' },
        { name: 'theme', type: 'select', label: 'Theme' }, // not responsive
      ],
      template: '<div data-block="grid" data-theme="{{theme}}" style="--cols:{{cols}};--gap:{{gap}}">{{children}}</div>',
      origin: 'core',
      created_at: '2026-01-01T00:00:00Z',
    },
  };

  it('substitutes the mobile baseline value when data is a responsive object', () => {
    const html = renderBlock(
      {
        id: 'g1',
        type: 'test/grid',
        data: { cols: { mobile: 1, desktop: 3 }, gap: 'md', theme: 'light' },
      },
      { registry: responsiveRegistry },
    );
    expect(html).toContain('--cols:1');
    expect(html).toContain('--gap:md');
    expect(html).toContain('data-theme="light"');
  });

  it('emits a per-instance <style> with @media overrides for non-mobile BPs', () => {
    const html = renderBlock(
      {
        id: 'g1',
        type: 'test/grid',
        data: { cols: { mobile: 1, tablet: 2, desktop: 3 }, gap: 'sm', theme: 'light' },
      },
      { registry: responsiveRegistry },
    );
    expect(html).toContain('data-bid="g1"');
    expect(html).toContain('<style data-bid="g1">');
    // !important: the inline `style="--cols:1"` mobile baseline would otherwise
    // outrank these stylesheet overrides and the breakpoints would never apply.
    expect(html).toContain('@media (min-width: 640px) { [data-bid="g1"] { --cols: 2 !important; } }');
    expect(html).toContain('@media (min-width: 1280px) { [data-bid="g1"] { --cols: 3 !important; } }');
    // Skip identical-to-previous BPs (laptop inherits tablet=2, no rule emitted)
    expect(html).not.toContain('@media (min-width: 1024px)');
  });

  it('does not emit a style block when no field is responsive-valued', () => {
    const html = renderBlock(
      {
        id: 'g1',
        type: 'test/grid',
        data: { cols: 3, gap: 'md', theme: 'light' }, // all scalars
      },
      { registry: responsiveRegistry },
    );
    expect(html).not.toContain('<style');
    expect(html).not.toContain('data-bid=');
  });

  it('rejects CSS-injection in responsive values', () => {
    const html = renderBlock(
      {
        id: 'g1',
        type: 'test/grid',
        data: {
          cols: { mobile: 1, desktop: '1; background: url(evil)' },
          gap: 'sm',
          theme: 'light',
        },
      },
      { registry: responsiveRegistry },
    );
    // The malicious desktop value is dropped entirely (sanitiser returns
    // empty string → variable not emitted at all)
    expect(html).not.toContain('url(evil)');
    expect(html).not.toContain('background');
  });

  it('only emits style + data-bid when overrides exist (not for scalar values)', () => {
    const html = renderBlock(
      {
        id: 'g1',
        type: 'test/grid',
        data: { cols: 2, gap: 'md', theme: 'light' },
      },
      { registry: responsiveRegistry },
    );
    expect(html).not.toContain('data-bid');
    expect(html).not.toContain('<style');
  });
});

describe('renderBlock — hidden_on', () => {
  it('adds data-hidden-{bp} attributes for each listed breakpoint', () => {
    const html = renderBlock(
      {
        id: 'h1',
        type: 'core/heading',
        data: { text: 'x', level: 'h2', size: 'auto', align: 'left', eyebrow: '' },
        hidden_on: ['mobile', 'tablet'],
      },
      { registry },
    );
    expect(html).toContain('data-hidden-mobile');
    expect(html).toContain('data-hidden-tablet');
    expect(html).not.toContain('data-hidden-desktop');
  });

  it('does nothing when hidden_on is empty', () => {
    const html = renderBlock(
      {
        id: 'h1',
        type: 'core/heading',
        data: { text: 'x', level: 'h2', size: 'auto', align: 'left', eyebrow: '' },
      },
      { registry },
    );
    expect(html).not.toContain('data-hidden-');
  });
});

describe('BLOCKS_RUNTIME_CSS', () => {
  it('defines visibility rules for every non-mobile breakpoint plus mobile', () => {
    expect(BLOCKS_RUNTIME_CSS).toContain('data-hidden-mobile');
    expect(BLOCKS_RUNTIME_CSS).toContain('data-hidden-tablet');
    expect(BLOCKS_RUNTIME_CSS).toContain('data-hidden-laptop');
    expect(BLOCKS_RUNTIME_CSS).toContain('data-hidden-desktop');
    expect(BLOCKS_RUNTIME_CSS).toContain('data-hidden-wide');
  });

  it('uses min/max-width queries so each BP only hides at the right size', () => {
    expect(BLOCKS_RUNTIME_CSS).toContain('max-width: 639px');
    expect(BLOCKS_RUNTIME_CSS).toContain('min-width: 1536px');
  });

  it('is included in collectBlockAssets output when blocks are present', () => {
    const r = buildCoreBlockRegistry();
    const blocks: Block[] = [{ id: 'h', type: 'core/heading', data: {} }];
    const assets = collectBlockAssets(blocks, r);
    expect(assets.css).toContain('blocks-runtime');
    expect(assets.css).toContain('data-hidden-mobile');
  });
});

describe('renderBlock — missing types', () => {
  it('falls through to an HTML comment by default', () => {
    const html = renderBlock(
      { id: 'b1', type: 'never-registered', data: {} },
      { registry },
    );
    expect(html).toBe('<!-- unknown block type: never-registered -->');
  });

  it('uses onMissingType when provided', () => {
    const html = renderBlock(
      { id: 'b1', type: 'never-registered', data: {} },
      {
        registry,
        onMissingType: (id) => `<div class="missing">${id}</div>`,
      },
    );
    expect(html).toBe('<div class="missing">never-registered</div>');
  });
});

describe('renderBlock — style overrides', () => {
  it('merges id/class/style into the root element instead of wrapping', () => {
    const html = renderBlock(
      {
        id: 'b1',
        type: 'core/heading',
        data: { text: 'Hi', level: 'h2', align: 'left', eyebrow: '' },
        style_overrides: { html_id: 'hero', custom_class: 'fancy', spacing_before: '2rem' },
      },
      { registry },
    );
    // No wrapper — attributes land on the block's own root element.
    expect(html.startsWith('<div data-block="heading"')).toBe(true);
    expect(html).toContain('id="hero"');
    expect(html).toContain('class="fancy"');
    // heading's root already has style="text-align:…" — margin is appended.
    expect(html).toMatch(/style="text-align:left;margin-top:2rem"/);
  });

  it('keeps a section a direct <section> child (full-bleed regression)', () => {
    // The full-bleed shell selects `.page-content--blocks > section`; a
    // wrapper div around an anchored section silently kills full-bleed.
    const html = renderBlock(
      {
        id: 's1',
        type: 'core/section',
        data: { width: 'normal', padding_y: 'lg', background: '#fff' },
        children: [],
        style_overrides: { html_id: 'ansokan', custom_class: 'gs-sec-apply' },
      },
      { registry },
    );
    expect(html.startsWith('<section ')).toBe(true);
    expect(html).toContain('id="ansokan"');
    expect(html).toMatch(/<section [^>]*class="gs-sec-apply"/);
    expect(html).not.toContain('<div id="ansokan"');
  });

  it('appends custom_class to an existing class attribute', () => {
    const classyType: BlockType = {
      id: 'test/classy',
      name: 'classy',
      label: 'Classy',
      icon: 'x',
      category: 'content',
      container: false,
      schema: [],
      template: '<div class="base" data-block="classy">x</div>',
      origin: 'core',
      created_at: '1970-01-01T00:00:00.000Z',
    };
    const html = renderBlock(
      {
        id: 'b1',
        type: 'test/classy',
        data: {},
        style_overrides: { custom_class: 'extra' },
      },
      { registry: { ...registry, 'test/classy': classyType } },
    );
    expect(html).toContain('class="base extra"');
  });

  it('falls back to wrapping when the root already has an id', () => {
    const fixedIdType: BlockType = {
      id: 'test/fixed-id',
      name: 'fixed-id',
      label: 'Fixed',
      icon: 'x',
      category: 'content',
      container: false,
      schema: [],
      template: '<div id="builtin" data-block="fixed">x</div>',
      origin: 'core',
      created_at: '1970-01-01T00:00:00.000Z',
    };
    const html = renderBlock(
      {
        id: 'b1',
        type: 'test/fixed-id',
        data: {},
        style_overrides: { html_id: 'override' },
      },
      { registry: { ...registry, 'test/fixed-id': fixedIdType } },
    );
    // Author-set id wins on the root; the override id survives on a wrapper.
    expect(html).toContain('<div id="override"><div id="builtin"');
  });

  it('falls back to wrapping when the html does not start with a tag', () => {
    const textFirstType: BlockType = {
      id: 'test/text-first',
      name: 'text-first',
      label: 'Text',
      icon: 'x',
      category: 'content',
      container: false,
      schema: [],
      template: 'plain text <em>root-less</em>',
      origin: 'core',
      created_at: '1970-01-01T00:00:00.000Z',
    };
    const html = renderBlock(
      {
        id: 'b1',
        type: 'test/text-first',
        data: {},
        style_overrides: { custom_class: 'fancy' },
      },
      { registry: { ...registry, 'test/text-first': textFirstType } },
    );
    expect(html.startsWith('<div class="fancy">')).toBe(true);
  });

  it('rejects css-injection in spacing values', () => {
    const html = renderBlock(
      {
        id: 'b1',
        type: 'core/heading',
        data: { text: 'Hi', level: 'h2', align: 'left', eyebrow: '' },
        style_overrides: { spacing_before: '2rem;background:url(evil)' },
      },
      { registry },
    );
    // The malicious value gets stripped to ''
    expect(html).not.toContain('url(evil)');
    expect(html).not.toContain('margin-top:2rem;background');
  });
});

describe('renderBlocks — top-level list', () => {
  it('concatenates an ordered list', () => {
    const blocks: Block[] = [
      { id: '1', type: 'core/heading', data: { text: 'A', level: 'h2', align: 'left', eyebrow: '' } },
      { id: '2', type: 'core/heading', data: { text: 'B', level: 'h2', align: 'left', eyebrow: '' } },
    ];
    const html = renderBlocks(blocks, { registry });
    expect(html.indexOf('A')).toBeLessThan(html.indexOf('B'));
  });
});

describe('collectUsedBlockTypeIds', () => {
  it('walks children + slots and collects every type', () => {
    const tree: Block[] = [
      {
        id: 's',
        type: 'core/section',
        data: {},
        children: [
          {
            id: 'c',
            type: 'core/columns',
            data: {},
            slots: [
              [{ id: 'h', type: 'core/heading', data: {} }],
              [{ id: 'p', type: 'core/prose', data: {} }],
            ],
          },
        ],
      },
      { id: 'b', type: 'core/button', data: {} },
    ];
    const ids = collectUsedBlockTypeIds(tree);
    expect([...ids].sort()).toEqual([
      'core/button',
      'core/columns',
      'core/heading',
      'core/prose',
      'core/section',
    ]);
  });
});

describe('collectBlockAssets', () => {
  it('returns CSS+JS for every BlockType used, in stable id order', () => {
    const registry: Record<string, BlockType> = {
      'a/two': {
        id: 'a/two', name: 'two', label: 'Two', category: 'content',
        container: false, schema: [], styles: '.two{color:red}',
        script: 'console.log("two")',
        created_at: '2026-01-01T00:00:00Z',
      },
      'a/one': {
        id: 'a/one', name: 'one', label: 'One', category: 'content',
        container: false, schema: [], styles: '.one{color:blue}',
        created_at: '2026-01-01T00:00:00Z',
      },
    };
    const blocks: Block[] = [
      { id: '1', type: 'a/two', data: {} },
      { id: '2', type: 'a/one', data: {} },
    ];
    const assets = collectBlockAssets(blocks, registry);
    // Sorted by id → "a/one" before "a/two"
    expect(assets.used_ids).toEqual(['a/one', 'a/two']);
    expect(assets.css.indexOf('.one')).toBeLessThan(assets.css.indexOf('.two'));
    // Only blocks with script contribute JS
    expect(assets.js).toContain('console.log("two")');
    expect(assets.js).not.toContain('.one');
  });

  it('skips block types not in registry without throwing', () => {
    const registry = buildCoreBlockRegistry();
    const blocks: Block[] = [
      { id: '1', type: 'core/heading', data: {} },
      { id: '2', type: 'nonexistent/thing', data: {} },
    ];
    const assets = collectBlockAssets(blocks, registry);
    expect(assets.used_ids).toContain('core/heading');
    expect(assets.used_ids).not.toContain('nonexistent/thing');
  });

  it('produces empty JS when no block has a script', () => {
    const registry = buildCoreBlockRegistry();
    const blocks: Block[] = [{ id: '1', type: 'core/heading', data: {} }];
    const assets = collectBlockAssets(blocks, registry);
    expect(assets.js).toBe('');
    expect(assets.css.length).toBeGreaterThan(0);
  });

  it('walks nested children + slots when collecting', () => {
    const registry = buildCoreBlockRegistry();
    const blocks: Block[] = [
      {
        id: 's', type: 'core/section', data: {}, children: [
          {
            id: 'c', type: 'core/columns', data: {}, slots: [
              [{ id: 'h', type: 'core/heading', data: {} }],
              [{ id: 'p', type: 'core/prose', data: {} }],
            ],
          },
        ],
      },
    ];
    const assets = collectBlockAssets(blocks, registry);
    expect(assets.used_ids.sort()).toEqual([
      'core/columns', 'core/heading', 'core/prose', 'core/section',
    ]);
  });

  it('includes per-instance custom CSS from nested block trees', () => {
    const blocks: Block[] = [
      {
        id: 'root',
        type: 'core/section',
        data: {},
        style_overrides: { custom_css: '.moveria-test { display: grid; }' },
        children: [
          {
            id: 'child',
            type: 'core/prose',
            data: { html: '<p>Test</p>' },
            style_overrides: { custom_css: '@media (max-width: 30rem) { .moveria-test { display: block; } }' },
          },
        ],
      },
    ];
    const assets = collectBlockAssets(blocks, registry);
    expect(assets.css).toContain('/* instance root */');
    expect(assets.css).toContain('.moveria-test { display: grid; }');
    expect(assets.css).toContain('/* instance child */');
    expect(assets.css).toContain('@media (max-width: 30rem)');
  });
});

describe('fnv1aHex', () => {
  it('is deterministic across processes', () => {
    expect(fnv1aHex('hello')).toBe(fnv1aHex('hello'));
    expect(fnv1aHex('')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs for different inputs', () => {
    expect(fnv1aHex('abc')).not.toBe(fnv1aHex('abd'));
  });
});

describe('Object-form registry', () => {
  it('accepts a plain Record<string, BlockType> as registry', () => {
    const customRegistry: Record<string, BlockType> = {
      'custom/banner': {
        id: 'custom/banner',
        name: 'banner',
        label: 'Banner',
        category: 'content',
        container: false,
        schema: [{ name: 'msg', type: 'text', label: 'Message' }],
        template: '<aside class="banner">{{msg}}</aside>',
        origin: 'user',
        created_at: '2026-01-01T00:00:00Z',
      },
    };
    const html = renderBlock(
      { id: 'b1', type: 'custom/banner', data: { msg: 'Hello' } },
      { registry: customRegistry },
    );
    expect(html).toBe('<aside class="banner">Hello</aside>');
  });
});

describe('composePageWithTemplate', () => {
  const pageBlocks: Block[] = [
    { id: 'p1', type: 'core/prose', data: { html: '<p>page body</p>' } },
  ];

  it('replaces template_content_slot with page blocks', () => {
    const tpl: Block[] = [
      { id: 's', type: 'core/section', data: {}, children: [
        { id: 'h', type: 'core/heading', data: { text: 'Top of template' } },
        { id: 'slot', type: 'template_content_slot', data: {} },
        { id: 'h2', type: 'core/heading', data: { text: 'Bottom of template' } },
      ] },
    ];
    const out = composePageWithTemplate(tpl, pageBlocks);
    const section = out[0];
    expect(section.children?.map((c) => c.id)).toEqual(['h', 'p1', 'h2']);
  });

  it('handles slot inside slot-container', () => {
    const tpl: Block[] = [
      { id: 'c', type: 'core/columns', data: {}, slots: [
        [{ id: 'left', type: 'core/heading', data: { text: 'Sidebar' } }],
        [{ id: 'slot', type: 'template_content_slot', data: {} }],
      ] },
    ];
    const out = composePageWithTemplate(tpl, pageBlocks);
    expect(out[0].slots?.[1].map((c) => c.id)).toEqual(['p1']);
    expect(out[0].slots?.[0].map((c) => c.id)).toEqual(['left']);
  });

  it('appends page blocks if template has no slot', () => {
    const tpl: Block[] = [
      { id: 'a', type: 'core/heading', data: { text: 'Header' } },
    ];
    const out = composePageWithTemplate(tpl, pageBlocks);
    expect(out.map((b) => b.id)).toEqual(['a', 'p1']);
  });

  it('does not mutate the inputs', () => {
    const tpl: Block[] = [
      { id: 's', type: 'core/section', data: {}, children: [
        { id: 'slot', type: 'template_content_slot', data: {} },
      ] },
    ];
    const tplJson = JSON.stringify(tpl);
    const pageJson = JSON.stringify(pageBlocks);
    composePageWithTemplate(tpl, pageBlocks);
    expect(JSON.stringify(tpl)).toBe(tplJson);
    expect(JSON.stringify(pageBlocks)).toBe(pageJson);
  });
});

describe('core/columns — mobile collapse beats the ratio rules (specificity regression)', () => {
  const columns = registry.get('core/columns');
  const styles = columns?.styles ?? '';

  // CSS specificity of a single compound selector, as [ids, classes/attrs, types].
  const specificity = (sel: string): [number, number, number] => {
    const ids = (sel.match(/#[\w-]+/g) || []).length;
    const attrs =
      (sel.match(/\[[^\]]*\]/g) || []).length +
      (sel.match(/\.[\w-]+/g) || []).length +
      (sel.match(/:[\w-]+/g) || []).length;
    const types = (sel.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
    return [ids, attrs, types];
  };
  const gte = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

  it('every non-default ratio still collapses to one column at <=720px', () => {
    const media = styles.match(/@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*?)\}\s*\}/);
    expect(media, 'columns block must keep a max-width:720px media query').toBeTruthy();
    const mediaBody = media![1];

    // The mobile rule that resets grid-template-columns to a single column.
    const collapseSelectors = mediaBody
      .split('{')[0]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const collapseSpec = collapseSelectors.map(specificity);

    // Each ratio rule that sets a multi-column track outside the media query.
    for (const ratio of ['2-1', '1-2', '3-1', '1-3']) {
      const ratioSel = `[data-block="columns"][data-ratio="${ratio}"]`;
      expect(styles).toContain(ratioSel);
      const ratioSpec = specificity(ratioSel);
      // At least one collapse selector must match this ratio's specificity or
      // higher, or the ratio rule wins and the column never stacks on mobile.
      const beats = collapseSpec.some((cs) => gte(cs, ratioSpec));
      expect(beats, `mobile collapse must out-rank ${ratioSel}`).toBe(true);
    }
  });
});

describe('inline-edit stamping (options.editable)', () => {
  const registry = buildCoreBlockRegistry();

  it('wraps text-context text-field tokens in data-edit spans', () => {
    const html = renderBlock(
      { id: 'cta1', type: 'core/cta', data: { heading: 'Köp nu', primary_label: 'Kontakt', primary_url: '/k' } } as never,
      { registry, editable: true },
    );
    expect(html).toContain('<span data-edit="cta1:heading" data-edit-kind="text">Köp nu</span>');
    expect(html).toContain('<span data-edit="cta1:primary_label" data-edit-kind="text">Kontakt</span>');
    // Attribute-context tokens are never wrapped.
    expect(html).toContain('href="/k"');
    expect(html).not.toContain('href="<span');
  });

  it('does not stamp richtext ({{{...}}}) fields or attribute occurrences', () => {
    const html = renderBlock(
      { id: 'h1', type: 'core/hero', data: { heading: 'Rubrik', subheading: '<p>Ingress</p>', image: 'https://cdn/x.webp' } } as never,
      { registry, editable: true },
    );
    expect(html).toContain('data-edit="h1:heading"');
    // subheading is richtext — raw token, untouched.
    expect(html).not.toContain('data-edit="h1:subheading"');
    // image is an image field used in attributes — untouched.
    expect(html).not.toContain('data-edit="h1:image"');
  });

  it('skips fields whose stored value carries a context binding', () => {
    const html = renderBlock(
      { id: 'cta2', type: 'core/cta', data: { heading: '{{site.name}} erbjudande' } } as never,
      { registry, editable: true },
    );
    expect(html).not.toContain('data-edit="cta2:heading"');
  });

  it('is off by default — production output carries no data-edit markers', () => {
    const html = renderBlock(
      { id: 'cta3', type: 'core/cta', data: { heading: 'Ren' } } as never,
      { registry },
    );
    expect(html).not.toContain('data-edit');
  });
});
