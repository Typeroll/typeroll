import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, buildBacklinkIndex } from '../index.js';
import type { Block, Page } from '../index.js';

const registry = buildCoreBlockRegistry();
const item = (id: string, extra = {}) => ({ id, title: id, slug: id, content_type: 'articles', content_mode: 'blocks', status: 'published', ...extra }) as Page;

const companies = [item('c1', { title: 'Acme' }), item('c2', { title: 'Beta' })];
const source = (cfg: { content_type?: string; ids?: string[] }) => {
  const base = cfg.content_type === 'companies' ? companies : [];
  if (cfg.ids) {
    const byId = new Map(base.map((i) => [i.id, i]));
    return cfg.ids.map((id) => byId.get(id)).filter(Boolean) as unknown as Record<string, unknown>[];
  }
  return base as unknown as Record<string, unknown>[];
};

const articles = [item('a1', { title: 'How Acme grew' })];
const articleSource = (cfg: { content_type?: string; ids?: string[] }) => {
  const base = cfg.content_type === 'articles' ? articles : [];
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
    const html = renderBlocks([repeater({ source_type: 'related', field: 'mentions', content_type: 'companies' })], {
      registry, pageSource: source,
      context: { page: { id: 'a1', mentions: ['c2', 'c1'] } },
    });
    expect(html).toContain('Beta');
    expect(html).toContain('Acme');
    expect(html.indexOf('Beta')).toBeLessThan(html.indexOf('Acme'));
  });

  it('renders nothing when the ref field is empty', () => {
    const html = renderBlocks([repeater({ source_type: 'related', field: 'mentions', content_type: 'companies' })], {
      registry, pageSource: source, context: { page: { id: 'a1' } },
    });
    expect(html).toBe('');
  });

  it('renders backlinks from the computed index', () => {
    const index = buildBacklinkIndex(
      [{ id: 'articles', fields: [{ name: 'mentions', type: 'page_ref_list', label: 'M', ref_content_type: 'companies' }] }],
      [item('a1', { fields: { mentions: ['c1'] } })],
    );
    // `collection` is where the RENDERED items live — the articles pointing
    // at this company, not the company's own collection.
    const html = renderBlocks([repeater({ source_type: 'backlinks', content_type: 'articles' })], {
      registry, pageSource: articleSource,
      context: { page: { id: 'c1' }, content_type: { name: 'companies' }, backlinks: index },
    });
    expect(html).toContain('How Acme grew');
  });

  it('honours limit', () => {
    const html = renderBlocks([repeater({ source_type: 'related', field: 'm', content_type: 'companies', limit: 1 })], {
      registry, pageSource: source, context: { page: { id: 'a1', m: ['c1', 'c2'] } },
    });
    expect(html).toContain('Acme');
    expect(html).not.toContain('Beta');
  });
});
