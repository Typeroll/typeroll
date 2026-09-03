import { describe, it, expect } from 'vitest';
import { REPEATER_BLOCK_TYPES } from '../repeater-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlock } from '../render-blocks.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();

describe('REPEATER_BLOCK_TYPES — structural invariants', () => {
  it('every repeater block has a unique id', () => {
    const ids = REPEATER_BLOCK_TYPES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every alias has an expand_to pointing at core/repeater', () => {
    const aliases = REPEATER_BLOCK_TYPES.filter((b) => b.id !== 'core/repeater');
    for (const bt of aliases) {
      expect(bt.expand_to?.target, `${bt.id} missing expand_to.target`).toBe('core/repeater');
      expect(bt.expand_to?.defaults.item_block, `${bt.id} missing item_block default`).toBeTruthy();
    }
  });

  it('every alias references a registered item_block', () => {
    const aliases = REPEATER_BLOCK_TYPES.filter((b) => b.id !== 'core/repeater');
    for (const bt of aliases) {
      const itemId = bt.expand_to!.defaults.item_block as string;
      expect(registry.has(itemId), `${bt.id} item_block ${itemId} not in registry`).toBe(true);
    }
  });

  it('every item_block referenced by an alias is item_compatible', () => {
    const aliases = REPEATER_BLOCK_TYPES.filter((b) => b.id !== 'core/repeater');
    for (const bt of aliases) {
      const itemId = bt.expand_to!.defaults.item_block as string;
      const itemBlock = registry.get(itemId);
      // core/image is the gallery's item_block. It isn't tagged
      // item_compatible because it's a general-purpose block — but it
      // works fine as a gallery item. Other aliases use item_compatible
      // blocks though.
      if (itemId === 'core/image') continue;
      expect(itemBlock?.item_compatible, `${itemId} (used by ${bt.id}) not item_compatible`).toBe(true);
    }
  });
});

describe('Repeater — static source rendering', () => {
  it('renders one item block per items[] entry', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: {
        source_type: 'static',
        item_block: 'core/icon_box',
        layout: 'grid',
        cols: 3,
        gap: 'md',
        items: [
          { heading: 'First', text: '<p>One</p>' },
          { heading: 'Second', text: '<p>Two</p>' },
          { heading: 'Third', text: '<p>Three</p>' },
        ],
      },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('data-block="repeater"');
    expect(html).toContain('First');
    expect(html).toContain('Second');
    expect(html).toContain('Third');
    // Each item rendered with the icon_box wrapper
    const matches = html.match(/data-block="icon_box"/g);
    expect(matches?.length).toBe(3);
  });

  it('applies item_overrides on top of each item', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: {
        source_type: 'static',
        item_block: 'core/icon_box',
        item_overrides: { heading_level: 'h2' },
        layout: 'grid',
        items: [
          { heading: 'A', heading_level: 'h4' },  // override should win
        ],
      },
    };
    const html = renderBlock(block, { registry });
    // The override (h2) wins over the item's own value (h4)
    expect(html).toContain('<h2 class="block-iconbox-heading">A</h2>');
  });

  it('emits an empty-state message when items is empty', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: {
        source_type: 'static',
        item_block: 'core/icon_box',
        layout: 'grid',
        items: [],
        empty_state: 'Nothing yet.',
      },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('Nothing yet.');
  });

  it('emits a comment when item_block is missing from registry', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: { source_type: 'static', item_block: 'does/not-exist', items: [{}] },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('<!-- repeater missing item_block');
  });
});

describe('Repeater — collection source rendering', () => {
  it('calls the collectionSource resolver and renders the returned items', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: {
        source_type: 'collection',
        collection: 'blog',
        limit: 10,
        item_block: 'core/post_card',
        layout: 'grid',
      },
    };
    const seen: unknown[] = [];
    const html = renderBlock(block, {
      registry,
      collectionSource: (config) => {
        seen.push(config);
        return [
          { title: 'Hello', excerpt: 'World' },
          { title: 'Bonjour', excerpt: 'Monde' },
        ];
      },
    });
    expect(seen[0]).toMatchObject({ collection: 'blog', limit: 10 });
    expect(html).toContain('Hello');
    expect(html).toContain('Bonjour');
  });

  it('emits a comment when collectionSource is missing', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: { source_type: 'collection', collection: 'blog', item_block: 'core/post_card' },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('<!-- repeater needs a collectionSource');
  });
});

describe('Repeater — children_blocks source', () => {
  it('renders each child block independently (mixed item shapes)', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: { source_type: 'children_blocks', item_block: 'core/icon_box', layout: 'list' },
      children: [
        { id: 'c1', type: 'core/heading', data: { text: 'One', level: 'h3', size: 'auto', align: 'left', eyebrow: '' } },
        { id: 'c2', type: 'core/heading', data: { text: 'Two', level: 'h3', size: 'auto', align: 'left', eyebrow: '' } },
      ],
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('data-block="repeater"');
    expect(html).toContain('One');
    expect(html).toContain('Two');
  });
});

describe('Alias expansion', () => {
  it('core/gallery expands to a repeater with image items', () => {
    const block: Block = {
      id: 'g1',
      type: 'core/gallery',
      data: {
        items: [
          { src: '/a.jpg', alt: 'A' },
          { src: '/b.jpg', alt: 'B' },
        ],
        cols: 2,
      },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('data-block="repeater"');
    // Two image items
    const matches = html.match(/data-block="image"/g);
    expect(matches?.length).toBe(2);
    expect(html).toContain('src="/a.jpg"');
    expect(html).toContain('src="/b.jpg"');
  });

  it('core/feature_grid expands to a repeater with icon_box items', () => {
    const block: Block = {
      id: 'f1',
      type: 'core/feature_grid',
      data: {
        items: [
          { heading: 'Fast', text: '<p>Quick</p>', icon: 'zap' },
          { heading: 'Safe', text: '<p>Secure</p>', icon: 'shield' },
        ],
      },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('data-block="repeater"');
    const matches = html.match(/data-block="icon_box"/g);
    expect(matches?.length).toBe(2);
    expect(html).toContain('Fast');
    expect(html).toContain('Safe');
  });

  it('core/testimonials expands with carousel layout', () => {
    const block: Block = {
      id: 't1',
      type: 'core/testimonials',
      data: {
        items: [{ quote: '<p>Great</p>', name: 'Alice' }],
      },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('data-layout="carousel"');
    expect(html).toContain('data-block="testimonial"');
  });

  it("author's data wins over alias defaults", () => {
    // Alias default is layout=grid; author overrides to list
    const block: Block = {
      id: 'lc1',
      type: 'core/logo_cloud',
      data: {
        items: [{ src: '/x.svg' }],
        layout: 'list',
      },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('data-layout="list"');
  });
});

describe('Repeater layouts — CSS', () => {
  it('groups items by a scalar or multi-value field with deterministic headings', () => {
    const block: Block = {
      id: 'grouped',
      type: 'core/repeater',
      data: {
        source_type: 'static', item_block: 'core/logo_item', layout: 'list',
        group_by: 'region', group_sort_order: 'asc', group_heading_level: 'h3',
        items: [
          { src: '/b.svg', region: 'West' },
          { src: '/a.svg', region: ['East', 'West'] },
        ],
      },
    };
    const html = renderBlock(block, { registry });
    expect(html.indexOf('>East</h3>')).toBeLessThan(html.indexOf('>West</h3>'));
    expect(html.match(/src="\/a.svg"/g)).toHaveLength(2);
  });

  it('grid layout uses --cols variable on the wrapper', () => {
    const block: Block = {
      id: 'r1',
      type: 'core/repeater',
      data: { source_type: 'static', item_block: 'core/logo_item', layout: 'grid', cols: 4, items: [{ src: '/a.svg' }] },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('--cols:4');
  });

  it('repeater bundle CSS defines all six layouts', () => {
    const css = registry.get('core/repeater')?.styles ?? '';
    for (const layout of ['grid', 'masonry', 'list', 'carousel', 'justified', 'stack']) {
      expect(css).toContain(`data-layout="${layout}"`);
    }
  });
});
