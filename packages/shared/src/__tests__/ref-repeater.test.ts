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

  it('sorts all resolved backlinks before limiting, while zero limit includes every member', async () => {
    const { createPageSource } = await import('../page-source.js');
    const type = { id: 'articles', name: 'articles', label_singular: 'Article', label_plural: 'Articles', route_template: '/{slug}',
      fields: [{ name: 'category', label: 'Category', type: 'page_ref' as const }], created_at: '2026-09-16' };
    const pages = Array.from({ length: 15 }, (_, i) => item(`entry-${i}`, { title: `Entry ${i}`, sort_order: 15 - i, fields: { category: 'cat' } }));
    const options = { registry, pageSource: createPageSource([type], pages), context: { page: { id: 'cat' }, backlinks: buildBacklinkIndex([type], pages) } };
    const data = { source_type: 'backlinks', content_type: 'articles', sort_by: 'sort_order', sort_order: 'asc' };
    const limited = renderBlocks([repeater({ ...data, limit: 2 })], options);
    expect(limited).toContain('Entry 14'); expect(limited).toContain('Entry 13'); expect(limited).not.toContain('>Entry 0<');
    expect(limited.indexOf('>Entry 14<')).toBeLessThan(limited.indexOf('>Entry 13<'));
    const complete = renderBlocks([repeater({ ...data, limit: 0 })], options);
    expect((complete.match(/data-block="post_card"/g) ?? []).length).toBe(15);
  });
});

it('offers native ordered Page selection across types and excludes the current Page before limiting', async () => {
  const { createPageSource } = await import('../page-source.js');
  const pages = [item('current', { content_type: 'page' }), item('article', { content_type: 'page' }),
    item('checklist', { content_type: 'checklists' }), item('draft', { content_type: 'page', status: 'draft' })];
  const pageSource = createPageSource([{ id: 'checklists', name: 'checklists', label_singular: 'Checklist', label_plural: 'Checklists', route_template: '/checklists/{slug}', fields: [], created_at: '2026-09-15T00:00:00Z' }], pages);
  const html = renderBlocks([repeater({ source_type: 'pages', page_ids: ['current', 'missing', 'draft', 'checklist', 'article'], exclude_current: true, limit: 2 })], {
    registry, pageSource, context: { page: { id: 'current' } },
  });
  expect(html).toContain('checklist'); expect(html).toContain('article');
  expect(html.indexOf('>checklist<')).toBeLessThan(html.indexOf('>article<'));
  expect(html).not.toContain('>current<'); expect(html).not.toContain('>draft<');
  const schema = registry.get('core/repeater')!.schema;
  expect(schema.find(field => field.name === 'source_type')?.options).toContain('related');
  expect(schema.find(field => field.name === 'page_ids')?.type).toBe('page_ref_list');
});

it('resolves related Page references before capping results and keeps the current Page out', async () => {
  const { createPageSource } = await import('../page-source.js');
  const pageSource = createPageSource([], ['current', 'second', 'third'].map(id => item(id, { content_type: 'page' })));
  const html = renderBlocks([repeater({ source_type: 'related', field: 'related', exclude_current: true, limit: 2 })], {
    registry, pageSource, context: { page: { id: 'current', related: ['missing', 'current', 'second', 'second', 'third'] } },
  });
  expect(html).toContain('second'); expect(html).toContain('third'); expect(html).not.toContain('>current<');
});
