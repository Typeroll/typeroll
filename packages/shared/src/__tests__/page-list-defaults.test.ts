import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, createPageSource, renderBlocks, type Block, type Page } from '../index.js';

const registry = buildCoreBlockRegistry();
const page = (id: string, parent: string | null = null) => ({ id, slug: id, path: id === 'home' ? '/' : `/${id}/`, title: `Title ${id}`, status: 'published', content_mode: 'blocks', blocks: [], parent }) as unknown as Page;
const pageSource = createPageSource([], [page('home'), page('contact'), page('journal'), page('post-1', 'journal'), page('post-2', 'journal')]);
const list: Block = { id: 'list', type: 'core/page_list', data: { cols: 3 } };
const titles = (renderVersion: number, data: Record<string, unknown> = {}) =>
  [...renderBlocks([{ ...list, data: { ...list.data, ...data } }], { registry, renderVersion, pageSource, context: { page: { id: 'journal' } } as never }).matchAll(/Title ([\w-]+)/g)].map(match => match[1]);

describe('page list defaults', () => {
  it('lists the current page children by default from version 14', () => {
    expect(new Set(titles(14))).toEqual(new Set(['post-1', 'post-2']));
    expect(titles(13)).toContain('contact');
  });
  it('keeps an explicit filter', () => {
    expect(titles(14, { filter_field: 'slug', filter_value: 'contact' })).toEqual(['contact']);
  });
});
