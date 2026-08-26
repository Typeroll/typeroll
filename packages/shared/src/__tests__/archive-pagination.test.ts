// Archive pagination: a collection repeater with `paginate` renders one
// slice + a pager, and findPaginatedListing tells the SSG how many
// /page/N/ routes to emit. Aliases (core/collection_list etc.) resolve
// through expand_to exactly like the renderer does.

import { describe, it, expect } from 'vitest';
import { renderBlock, findPaginatedListing } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();

const ITEMS = Array.from({ length: 5 }, (_, i) => ({
  title: `Post ${i + 1}`, body: `<p>b${i + 1}</p>`,
}));

function repeaterBlock(data: Record<string, unknown>): Block {
  return {
    id: 'rep1',
    type: 'core/repeater',
    data: {
      source_type: 'collection',
      collection: 'blog',
      item_block: 'core/post_card',
      ...data,
    },
  } as Block;
}

describe('paginated repeater rendering', () => {
  it('renders the requested slice with a pager (prev/next + numbers)', () => {
    const html = renderBlock(repeaterBlock({ paginate: 2 }), {
      registry,
      collectionSource: () => ITEMS,
      context: { pagination: { current: 2, base_url: '/blog/' } },
    });
    expect(html).toContain('Post 3');
    expect(html).toContain('Post 4');
    expect(html).not.toContain('Post 1');
    expect(html).not.toContain('Post 5');
    expect(html).toContain('data-block="pager"');
    expect(html).toContain('href="/blog/" rel="prev"');
    expect(html).toContain('aria-current="page">2<');
    expect(html).toContain('href="/blog/page/3/" rel="next"');
  });

  it('defaults to page 1 when no pagination context is set (editor preview)', () => {
    const html = renderBlock(repeaterBlock({ paginate: 2 }), {
      registry,
      collectionSource: () => ITEMS,
    });
    expect(html).toContain('Post 1');
    expect(html).toContain('Post 2');
    expect(html).not.toContain('Post 3');
    expect(html).toContain('data-block="pager"'); // pager shows on page 1 too
  });

  it('paginate supersedes limit — the source is queried unbounded', () => {
    let received: { limit?: number } | null = null;
    renderBlock(repeaterBlock({ paginate: 2, limit: 3 }), {
      registry,
      collectionSource: (cfg) => { received = cfg; return ITEMS; },
    });
    expect(received!.limit).toBeUndefined();
  });

  it('no pager when everything fits on one page', () => {
    const html = renderBlock(repeaterBlock({ paginate: 10 }), {
      registry,
      collectionSource: () => ITEMS,
    });
    expect(html).toContain('Post 5');
    expect(html).not.toContain('data-block="pager"');
  });
});

describe('findPaginatedListing', () => {
  it('finds a direct repeater and a nested alias, merging expand_to defaults', () => {
    const direct = findPaginatedListing([repeaterBlock({ paginate: 4, sort_by: 'date' })], registry);
    expect(direct).toMatchObject({ collection: 'blog', per_page: 4, sort_by: 'date' });

    const nested: Block[] = [{
      id: 'sec', type: 'core/section', data: {},
      children: [{
        id: 'list', type: 'core/collection_list',
        data: { collection: 'blog', paginate: 6 },
      } as Block],
    } as Block];
    const alias = findPaginatedListing(nested, registry);
    expect(alias).toMatchObject({ collection: 'blog', per_page: 6 });
  });

  it('returns null for unpaginated listings and static repeaters', () => {
    expect(findPaginatedListing([repeaterBlock({})], registry)).toBeNull();
    expect(findPaginatedListing([
      { id: 'r', type: 'core/repeater', data: { source_type: 'static', paginate: 3, items: [] } } as Block,
    ], registry)).toBeNull();
  });
});
