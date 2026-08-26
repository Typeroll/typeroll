import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, buildBacklinkIndex } from '../index.js';
import type { Block, CollectionItem } from '../index.js';

const registry = buildCoreBlockRegistry();
const item = (id: string, extra = {}) => ({ id, status: 'published', created_at: 'x', updated_at: 'x', ...extra }) as CollectionItem;

const companies = [item('c1', { title: 'Acme' }), item('c2', { title: 'Beta' })];
const source = (cfg: { collection: string; ids?: string[] }) => {
  const base = cfg.collection === 'companies' ? companies : [];
  if (cfg.ids) {
    const byId = new Map(base.map((i) => [i.id, i]));
    return cfg.ids.map((id) => byId.get(id)).filter(Boolean) as unknown as Record<string, unknown>[];
  }
  return base as unknown as Record<string, unknown>[];
};

const articles = [item('a1', { title: 'How Acme grew' })];
const articleSource = (cfg: { collection: string; ids?: string[] }) => {
  const base = cfg.collection === 'articles' ? articles : [];
  if (cfg.ids) {
    const byId = new Map(base.map((i) => [i.id, i]));
    return cfg.ids.map((id) => byId.get(id)).filter(Boolean) as unknown as Record<string, unknown>[];
  }
  return base as unknown as Record<string, unknown>[];
};

const repeater = (data: Record<string, unknown>): Block =>
  ({ id: 'r1', type: 'core/repeater', data: { item_block: 'core/post_card', ...data } }) as Block;

describe('reference-backed repeaters', () => {
  it('renders a related list from a ref field on the context item', () => {
    const html = renderBlocks([repeater({ source_type: 'related', field: 'mentions', collection: 'companies' })], {
      registry, collectionSource: source,
      context: { item: { id: 'a1', mentions: ['c2', 'c1'] } },
    });
    expect(html).toContain('Beta');
    expect(html).toContain('Acme');
    expect(html.indexOf('Beta')).toBeLessThan(html.indexOf('Acme'));
  });

  it('renders nothing when the ref field is empty', () => {
    const html = renderBlocks([repeater({ source_type: 'related', field: 'mentions', collection: 'companies' })], {
      registry, collectionSource: source, context: { item: { id: 'a1' } },
    });
    expect(html).toBe('');
  });

  it('renders backlinks from the computed index', () => {
    const index = buildBacklinkIndex(
      [{ name: 'articles', fields: [{ name: 'mentions', type: 'item_ref_list', label: 'M', ref_collection: 'companies' }] }],
      { articles: [item('a1', { mentions: ['c1'] })] },
    );
    // `collection` is where the RENDERED items live — the articles pointing
    // at this company, not the company's own collection.
    const html = renderBlocks([repeater({ source_type: 'backlinks', collection: 'articles' })], {
      registry, collectionSource: articleSource,
      context: { item: { id: 'c1' }, collection: { name: 'companies' }, backlinks: index },
    });
    expect(html).toContain('How Acme grew');
  });

  it('honours limit', () => {
    const html = renderBlocks([repeater({ source_type: 'related', field: 'm', collection: 'companies', limit: 1 })], {
      registry, collectionSource: source, context: { item: { id: 'a1', m: ['c1', 'c2'] } },
    });
    expect(html).toContain('Acme');
    expect(html).not.toContain('Beta');
  });
});
