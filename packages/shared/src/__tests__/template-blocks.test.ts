import { describe, it, expect } from 'vitest';
import { TEMPLATE_BLOCK_TYPES } from '../template-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlock, renderBlocks } from '../render-blocks.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();

describe('TEMPLATE_BLOCK_TYPES — structural invariants', () => {
  it('every template block has a unique id in the template/ namespace', () => {
    const ids = TEMPLATE_BLOCK_TYPES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^template\//);
    }
  });

  it('every template block has origin=core (ships with the platform)', () => {
    for (const bt of TEMPLATE_BLOCK_TYPES) {
      expect(bt.origin).toBe('core');
    }
  });
});

describe('Context substitution — page namespace', () => {
  it('substitutes {{page.title}} from context', () => {
    const block: Block = {
      id: 'pt',
      type: 'template/page_title',
      data: { level: 'h1', size: 'auto', align: 'left' },
    };
    const html = renderBlock(block, {
      registry,
      context: { page: { title: 'Hello world' } },
    });
    expect(html).toContain('<h1 class="block-heading-text">Hello world</h1>');
  });

  it('HTML-escapes context values like block-local fields', () => {
    const block: Block = {
      id: 'pt',
      type: 'template/page_title',
      data: { level: 'h1', size: 'auto', align: 'left' },
    };
    const html = renderBlock(block, {
      registry,
      context: { page: { title: '<script>alert(1)</script>' } },
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns empty string when context lacks the path', () => {
    const block: Block = {
      id: 'pt',
      type: 'template/page_title',
      data: { level: 'h1', size: 'auto', align: 'left' },
    };
    const html = renderBlock(block, { registry, context: {} });
    expect(html).toContain('<h1 class="block-heading-text"></h1>');
  });

  it('walks deep dotted paths (page.author.name)', () => {
    const block: Block = {
      id: 'a',
      type: 'template/page_author',
      data: { prefix: 'By' },
    };
    const html = renderBlock(block, {
      registry,
      context: { page: { author: { name: 'Ada Lovelace', avatar: '/a.jpg' } } },
    });
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('src="/a.jpg"');
  });
});

describe('Context substitution — site namespace', () => {
  it('substitutes {{site.name}} + {{site.logo}}', () => {
    const block: Block = {
      id: 'l',
      type: 'template/site_logo',
      data: { height: 'md', link_to_home: true },
    };
    const html = renderBlock(block, {
      registry,
      context: { site: { name: 'Acme', logo: '/logo.svg' } },
    });
    expect(html).toContain('alt="Acme"');
    expect(html).toContain('src="/logo.svg"');
  });
});

describe('Context substitution — raw vs escaped', () => {
  it('triple-brace passes raw HTML for richtext fields', () => {
    const block: Block = {
      id: 'ib',
      type: 'template/item_body',
      data: { field: 'body', max_width: 'normal' },
    };
    const html = renderBlock(block, {
      registry,
      context: { item: { body: '<p><strong>Bold</strong></p>' } },
    });
    expect(html).toContain('<p><strong>Bold</strong></p>');
  });
});

describe('container: conditional', () => {
  it('renders children when condition is truthy', () => {
    const block: Block = {
      id: 'c',
      type: 'template/show_if',
      data: { condition: 'page.featured_image' },
      children: [
        {
          id: 'h',
          type: 'core/heading',
          data: { text: 'Featured!', level: 'h2', size: 'auto', align: 'left', eyebrow: '' },
        },
      ],
    };
    const html = renderBlock(block, {
      registry,
      context: { page: { featured_image: '/img.jpg' } },
    });
    expect(html).toContain('Featured!');
  });

  it('renders nothing when condition is falsy', () => {
    const block: Block = {
      id: 'c',
      type: 'template/show_if',
      data: { condition: 'page.featured_image' },
      children: [
        { id: 'h', type: 'core/heading', data: { text: 'Featured!', level: 'h2', size: 'auto', align: 'left', eyebrow: '' } },
      ],
    };
    const html = renderBlock(block, {
      registry,
      context: { page: { title: 'no image' } },
    });
    expect(html).toBe('');
  });

  it('supports === string comparisons', () => {
    const block: Block = {
      id: 'c',
      type: 'template/show_if',
      data: { condition: 'page.status === "published"' },
      children: [{ id: 'h', type: 'core/heading', data: { text: 'Yes', level: 'h2', size: 'auto', align: 'left', eyebrow: '' } }],
    };
    const yes = renderBlock(block, { registry, context: { page: { status: 'published' } } });
    expect(yes).toContain('Yes');
    const no = renderBlock(block, { registry, context: { page: { status: 'draft' } } });
    expect(no).toBe('');
  });

  it('supports negation (! prefix)', () => {
    const block: Block = {
      id: 'c',
      type: 'template/show_if',
      data: { condition: '!page.draft' },
      children: [{ id: 'h', type: 'core/heading', data: { text: 'live', level: 'h2', size: 'auto', align: 'left', eyebrow: '' } }],
    };
    const live = renderBlock(block, { registry, context: { page: { draft: false } } });
    expect(live).toContain('live');
    const hidden = renderBlock(block, { registry, context: { page: { draft: true } } });
    expect(hidden).toBe('');
  });

  it('supports && / || combinators', () => {
    const block: Block = {
      id: 'c',
      type: 'template/show_if',
      data: { condition: 'page.title && page.status === "published"' },
      children: [{ id: 'h', type: 'core/heading', data: { text: 'OK', level: 'h2', size: 'auto', align: 'left', eyebrow: '' } }],
    };
    const ok = renderBlock(block, {
      registry,
      context: { page: { title: 'x', status: 'published' } },
    });
    expect(ok).toContain('OK');
    const notOk = renderBlock(block, {
      registry,
      context: { page: { title: 'x', status: 'draft' } },
    });
    expect(notOk).toBe('');
  });

  it('fails closed on unparseable conditions', () => {
    const block: Block = {
      id: 'c',
      type: 'template/show_if',
      data: { condition: 'eval("nope")' },
      children: [{ id: 'h', type: 'core/heading', data: { text: 'no', level: 'h2', size: 'auto', align: 'left', eyebrow: '' } }],
    };
    const html = renderBlock(block, { registry, context: { page: {} } });
    expect(html).toBe('');
  });
});

describe('Item context inside repeater iteration', () => {
  it('item-context blocks resolve against the current iteration item', () => {
    const block: Block = {
      id: 'r',
      type: 'core/repeater',
      data: {
        source_type: 'static',
        item_block: 'template/item_title',
        layout: 'list',
        items: [
          { title: 'First post' },
          { title: 'Second post' },
        ],
      },
    };
    const html = renderBlock(block, { registry });
    expect(html).toContain('First post');
    expect(html).toContain('Second post');
  });

  it('does not leak item context across sibling blocks', () => {
    // Render two repeaters in sequence — context.item from the first
    // must not bleed into substitution of the second.
    const blocks: Block[] = [
      {
        id: 'r1',
        type: 'core/repeater',
        data: {
          source_type: 'static',
          item_block: 'template/item_title',
          layout: 'list',
          items: [{ title: 'A' }],
        },
      },
      {
        id: 'h2',
        type: 'core/heading',
        // This heading is OUTSIDE the repeater — {{item}} should resolve
        // to nothing here.
        data: { text: 'After', level: 'h2', size: 'auto', align: 'left', eyebrow: '' },
      },
    ];
    const html = renderBlocks(blocks, { registry, context: { page: { title: 'Page' } } });
    expect(html).toContain('A');
    expect(html).toContain('After');
  });
});
