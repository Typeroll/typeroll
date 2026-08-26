import { describe, it, expect } from 'vitest';
import { TIER1_BLOCK_TYPES } from '../tier1-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlock } from '../render-blocks.js';
import type { Block, BlockType } from '../types.js';

// Smoke + contract tests for the Tier 1 library. These don't visually
// validate the rendered output — they only assert structural invariants
// the rest of the system depends on (every block parses, has a unique
// id, has a usable template, etc.). Per-block visual snapshots happen
// in the editor preview tests once the editor wires up.

describe('TIER1_BLOCK_TYPES — structural invariants', () => {
  it('every block has a unique id', () => {
    const ids = TIER1_BLOCK_TYPES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every block id uses the core/ namespace', () => {
    for (const bt of TIER1_BLOCK_TYPES) {
      expect(bt.id).toMatch(/^core\//);
    }
  });

  it('every block has a non-empty schema and category', () => {
    for (const bt of TIER1_BLOCK_TYPES) {
      expect(bt.label).toBeTruthy();
      expect(bt.category).toBeTruthy();
      expect(bt.created_at).toBeTruthy();
      expect(bt.origin).toBe('core');
    }
  });

  it('every block has a template', () => {
    for (const bt of TIER1_BLOCK_TYPES) {
      expect(bt.template, `${bt.id} missing template`).toBeTruthy();
      expect(bt.template!.length).toBeGreaterThan(10);
    }
  });

  it('every block scopes its styles under [data-block="…"]', () => {
    for (const bt of TIER1_BLOCK_TYPES) {
      if (!bt.styles) continue;
      // Strip @media rules to inspect inner content
      const inner = bt.styles.replace(/@media[^{]+\{[\s\S]*?\}\s*\}/g, '');
      // Every non-trivial selector should mention [data-block="..."]
      const selectors = inner.split('}').map((s) => s.split('{')[0]?.trim() ?? '').filter(Boolean);
      for (const sel of selectors) {
        // Allow empty (whitespace-only) selectors after split
        if (!sel) continue;
        expect(sel, `${bt.id} has unscoped selector: ${sel}`).toMatch(/\[data-block="/);
      }
    }
  });

  it('item-compatible blocks are tagged so the repeater picker can find them', () => {
    const itemCompatibleIds = TIER1_BLOCK_TYPES.filter((b) => b.item_compatible).map((b) => b.id);
    expect(itemCompatibleIds).toContain('core/icon_box');
    expect(itemCompatibleIds).toContain('core/testimonial');
    expect(itemCompatibleIds).toContain('core/team_member');
    expect(itemCompatibleIds).toContain('core/pricing_plan');
    expect(itemCompatibleIds).toContain('core/post_card');
    expect(itemCompatibleIds).toContain('core/logo_item');
    expect(itemCompatibleIds).toContain('core/step_card');
  });
});

describe('TIER1_BLOCK_TYPES — smoke render', () => {
  const registry = buildCoreBlockRegistry();

  // For each block, render with reasonable default data and assert the
  // outer `data-block="..."` attribute appears. This catches template
  // syntax errors (broken substitution, unclosed tags) at unit-test
  // speed across every block in the library.
  it.each(TIER1_BLOCK_TYPES.map((bt) => [bt.id, bt] as [string, BlockType]))(
    'renders %s without throwing',
    (id, bt) => {
      const block: Block = {
        id: `test-${bt.name}`,
        type: id,
        data: defaultDataFor(bt),
      };
      const html = renderBlock(block, { registry });
      expect(html).toContain(`data-block="${bt.name}"`);
    },
  );
});

describe('TIER1_BLOCK_TYPES — responsive fields integration', () => {
  const registry = buildCoreBlockRegistry();

  it('grid emits per-instance style block when cols is responsive', () => {
    const html = renderBlock(
      {
        id: 'g',
        type: 'core/grid',
        data: { cols: { mobile: 1, tablet: 2, desktop: 4 }, gap: 'md', align: 'stretch' },
      },
      { registry },
    );
    expect(html).toContain('--cols:1'); // mobile baseline in template
    expect(html).toContain('data-bid="g"');
    expect(html).toContain('--cols: 2');
    expect(html).toContain('--cols: 4');
  });

  it('icon_box maps a responsive token field (layout) to per-breakpoint CSS', () => {
    const html = renderBlock(
      {
        id: 'ib',
        type: 'core/icon_box',
        data: { icon: 'star', heading: 'X', layout: { mobile: 'icon-top', tablet: 'icon-left' } },
      },
      { registry },
    );
    // Mobile baseline stays the inline token (handled by [style*]).
    expect(html).toContain('--layout:icon-top');
    expect(html).toContain('data-bid="ib"');
    // The tablet override emits the MAPPED declaration (not the raw token) on a
    // doubled-specificity selector so it beats the [style*] baseline.
    expect(html).toContain('@media (min-width: 640px)');
    expect(html).toContain('[data-bid="ib"][data-bid="ib"] { --layout-dir: row; }');
    // The raw token must NOT leak as a --layout var override (that wouldn't work).
    expect(html).not.toContain('--layout: icon-left');
  });

  it('strips responsive_css declarations that try to break out of the rule', () => {
    // A malicious custom block type could craft a token map; the renderer must
    // refuse anything containing rule/at-rule breakout characters.
    const evilRegistry = new Map(registry);
    const base = registry.get('core/icon_box')!;
    evilRegistry.set('core/icon_box', {
      ...base,
      schema: base.schema.map((f) =>
        f.name === 'layout'
          ? { ...f, responsive_css: { 'icon-left': '} body { display:none } /*' } }
          : f,
      ),
    });
    const html = renderBlock(
      { id: 'ib', type: 'core/icon_box', data: { layout: { mobile: 'icon-top', tablet: 'icon-left' } } },
      { registry: evilRegistry },
    );
    expect(html).not.toContain('display:none');
    expect(html).not.toContain('body {');
  });

  it('container honours responsive padding_y', () => {
    const html = renderBlock(
      {
        id: 'c',
        type: 'core/container',
        data: {
          padding_y: { mobile: 'sm', desktop: 'xl' },
          width: 'normal',
          direction: 'column',
        },
      },
      { registry },
    );
    expect(html).toContain('--padding_y:sm');
    expect(html).toContain('--padding_y: xl');
  });
});

/**
 * Generate plausible default data for a block based on its schema.
 * Required-field smoke tests need non-empty values so the rendered HTML
 * doesn't collapse to a hollow placeholder we can't inspect.
 */
function defaultDataFor(bt: BlockType): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of bt.schema) {
    if (f.default !== undefined) {
      data[f.name] = f.default;
      continue;
    }
    switch (f.type) {
      case 'text': case 'textarea':
        data[f.name] = f.required ? 'Sample text' : '';
        break;
      case 'richtext':
        data[f.name] = '<p>Sample</p>';
        break;
      case 'select':
        data[f.name] = f.options?.[0] ?? '';
        break;
      case 'number':
        data[f.name] = f.min ?? 1;
        break;
      case 'boolean':
        data[f.name] = false;
        break;
      case 'array':
        data[f.name] = [];
        break;
      default:
        data[f.name] = '';
    }
  }
  return data;
}

describe('core/html — raw HTML escape hatch', () => {
  const registry = buildCoreBlockRegistry();

  it('emits the html field raw (no entity-escaping)', () => {
    const html = renderBlock(
      {
        id: 'h1',
        type: 'core/html',
        data: { html: '<form action="/x" method="POST"><input type="hidden" name="_token" value="t"></form>' },
      } as Block,
      { registry },
    );
    expect(html).toContain('data-block="html"');
    expect(html).toContain('<form action="/x" method="POST">');
    expect(html).not.toContain('&lt;form');
  });

  it('is registered in the core registry under core/html', () => {
    expect(registry.get('core/html')).toBeDefined();
    expect(registry.get('core/html')?.origin).toBe('core');
  });
});

describe('server-rendered buttons (hero/cta) + media_card', () => {
  const registry = buildCoreBlockRegistry();

  it('hero renders primary/secondary buttons server-side — no hydration div', () => {
    const html = renderBlock(
      { id: 'h', type: 'core/hero', data: {
        heading: 'Rubrik', primary_label: 'Ansök nu', primary_url: '/ansok',
      } } as Block,
      { registry },
    );
    expect(html).toContain('class="block-btn block-btn-primary"');
    expect(html).toContain('href="/ansok"');
    expect(html).toContain('Ansök nu');
    expect(html).not.toContain('data-buttons');
  });

  it('cta renders buttons server-side too', () => {
    const html = renderBlock(
      { id: 'c', type: 'core/cta', data: { heading: 'X', primary_label: 'Go', primary_url: '/go' } } as Block,
      { registry },
    );
    expect(html).toContain('block-btn-primary');
    expect(html).not.toContain('data-buttons');
  });

  it('media_card renders image side + heading level + button', () => {
    const html = renderBlock(
      { id: 'm', type: 'core/media_card', data: {
        image: 'https://cdn.example.com/x.jpg', image_alt: 'Lag',
        image_side: 'right', heading: 'För klasser', heading_level: 'h2',
        text: '<p>Text</p>', button_label: 'Läs mer', button_url: '/mer',
      } } as Block,
      { registry },
    );
    expect(html).toContain('data-block="media_card"');
    expect(html).toContain('data-side="right"');
    expect(html).toContain('<h2 class="block-mediacard-heading">För klasser</h2>');
    expect(html).toContain('src="https://cdn.example.com/x.jpg"');
    expect(html).toContain('href="/mer"');
  });

  it('core/image emits radius attribute', () => {
    const html = renderBlock(
      { id: 'i', type: 'core/image', data: { src: 'https://cdn.example.com/y.jpg', alt: 'y', radius: 'lg' } } as Block,
      { registry },
    );
    expect(html).toContain('data-radius="lg"');
  });
});

describe('core/grid — last_row centering', () => {
  const registry = buildCoreBlockRegistry();
  const kids = [
    { id: 'k1', type: 'core/prose', data: { html: '<p>1</p>' } },
    { id: 'k2', type: 'core/prose', data: { html: '<p>2</p>' } },
    { id: 'k3', type: 'core/prose', data: { html: '<p>3</p>' } },
    { id: 'k4', type: 'core/prose', data: { html: '<p>4</p>' } },
    { id: 'k5', type: 'core/prose', data: { html: '<p>5</p>' } },
  ];

  it('unset last_row never activates centering (no change for existing sites)', () => {
    // The renderer doesn't inject schema defaults — an unset field renders
    // as data-last-row="". The centering CSS keys EXACTLY on "center", so
    // every pre-existing grid keeps its grid layout untouched.
    const html = renderBlock(
      { id: 'g', type: 'core/grid', data: { cols: 3, gap: 'lg' }, children: kids } as never,
      { registry },
    );
    expect(html).not.toContain('data-last-row="center"');
  });

  it('renders data-last-row="center" when set', () => {
    const html = renderBlock(
      { id: 'g', type: 'core/grid', data: { cols: 3, gap: 'lg', last_row: 'center' }, children: kids } as never,
      { registry },
    );
    expect(html).toContain('data-last-row="center"');
  });

  it('ships the flex-centering CSS keyed to the attribute', () => {
    const grid = registry.get('core/grid');
    expect(grid?.styles).toContain('[data-block="grid"][data-last-row="center"]');
    expect(grid?.styles).toContain('justify-content: center');
    // flex-basis derives from the same vars the responsive system writes —
    // --cols directly, so per-breakpoint responsive overrides flow through
    expect(grid?.styles).toContain('var(--cols, 3) - 1) * var(--block-gap, 1rem)');
    // flex stretch must own row-height equalization (child height:100% is a grid-ism)
    expect(grid?.styles).toMatch(/data-last-row="center"\] > \*[^}]*height: auto/s);
  });

  it('reads --cols directly so responsive cols overrides take effect', () => {
    const grid = registry.get('core/grid');
    // The track count must come from the variable the @media compiler writes…
    expect(grid?.styles).toContain('grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));');
    // …NOT a substring-mapped indirection that the @media override can't reach.
    expect(grid?.styles).not.toMatch(/grid-template-columns:[^;]*--block-cols/);
    expect(grid?.styles).not.toMatch(/\[style\*="--cols:\d"\]/);
    // stack_at collapse targets --cols and MUST be !important to beat the
    // inline `style="--cols:N"` baseline (an inline custom property otherwise
    // wins the cascade and the grid never collapses).
    expect(grid?.styles).toContain(':not([data-bid]) { --cols: 1 !important; }');
  });

  it('emits per-breakpoint --cols @media rules that the grid CSS consumes', () => {
    const html = renderBlock(
      { id: 'g', type: 'core/grid', data: { cols: { mobile: 1, tablet: 2, laptop: 4 } }, children: kids } as never,
      { registry },
    );
    expect(html).toContain('--cols:1'); // mobile baseline inline
    // Overrides must be !important — the inline mobile baseline would otherwise
    // shadow them and per-breakpoint cols would silently never apply.
    expect(html).toContain('@media (min-width: 640px) { [data-bid="g"] { --cols: 2 !important; } }');
    expect(html).toContain('@media (min-width: 1024px) { [data-bid="g"] { --cols: 4 !important; } }');
  });
});

describe('core/feature_row — gutter-hugging section row', () => {
  const registry = buildCoreBlockRegistry();
  const data = {
    heading: 'Fast builds',
    heading_level: 'h3',
    text: '<p>Deploys in seconds.</p>',
    image: 'https://cdn.example/img.webp',
    image_alt: 'Build pipeline',
    image_side: 'right',
    stack_order: 'text-first',
  };

  it('renders structure, heading level, and data attributes', () => {
    const html = renderBlock({ id: 'fr', type: 'core/feature_row', data } as never, { registry });
    expect(html).toContain('data-block="feature_row"');
    expect(html).toContain('data-image-side="right"');
    expect(html).toContain('data-stack-order="text-first"');
    expect(html).toContain('<h3 class="block-frow-heading">Fast builds</h3>');
    expect(html).toContain('alt="Build pipeline"');
    expect(html).toContain('<p>Deploys in seconds.</p>'); // richtext raw
  });

  it('is registered in the core registry', () => {
    expect(registry.get('core/feature_row')).toBeTruthy();
  });

  // Same regression class as core/columns: rules inside @media must match
  // the specificity of every attribute-qualified base rule they override,
  // or the mobile stack silently loses the cascade.
  it('mobile stack rules out-rank the desktop image-side rules', () => {
    const styles = registry.get('core/feature_row')?.styles ?? '';
    const media = styles.match(/@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*)\}\s*$/);
    expect(media, 'feature_row must keep a max-width:720px media query').toBeTruthy();
    const body = media![1];

    const specificity = (sel: string): number =>
      (sel.match(/\[[^\]]*\]/g) || []).length + (sel.match(/\.[\w-]+/g) || []).length;

    const desktopOrderSpec = specificity(
      '[data-block="feature_row"][data-image-side="right"] .block-frow-media',
    );
    // The mobile order rules for media + body must each contain at least one
    // selector at >= that specificity.
    for (const part of ['.block-frow-media', '.block-frow-body']) {
      const rules = body
        .split('}')
        .map((r) => r.split('{')[0])
        .filter((sel) => sel.includes(part) && !sel.includes('img'));
      expect(rules.length, `no mobile rules for ${part}`).toBeGreaterThan(0);
      const best = Math.max(
        ...rules.flatMap((sel) => sel.split(',').map((s) => specificity(s.trim()))),
      );
      expect(best, `mobile ${part} rules must out-rank desktop image-side rules`)
        .toBeGreaterThanOrEqual(desktopOrderSpec);
    }
    // stack_order override must come AFTER the image-side mobile rules so it
    // wins the order tie by source order.
    const stackIdx = body.indexOf('[data-stack-order="text-first"]');
    const sideIdx = body.indexOf('[data-image-side="right"] .block-frow-media');
    expect(stackIdx).toBeGreaterThan(sideIdx);
  });
});

describe('scripted blocks — runtime init selector (production regression)', () => {
  const registry = buildCoreBlockRegistry();

  it('a script-bearing block carries data-block-type WITHOUT annotate', () => {
    // The client runtime finds instances via [data-block-type=id]. This
    // used to be stamped only in annotate mode (editor preview) — tabs and
    // every custom scripted block were dead on deployed sites.
    const html = renderBlock(
      { id: 't1', type: 'core/tabs', data: {}, slots: [[{ id: 'c', type: 'core/prose', data: { text: 'x' } }]] } as never,
      { registry },
    );
    expect(html).toContain('data-block-type="core/tabs"');
  });

  it('script-less blocks stay clean in production output', () => {
    const html = renderBlock(
      { id: 'p1', type: 'core/prose', data: { text: '<p>x</p>' } } as never,
      { registry },
    );
    expect(html).not.toContain('data-block-type');
  });
});
