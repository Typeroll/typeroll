import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { unknownItemFields } from '../block-unknown-fields.js';
import { blockTreeWarnings } from '../block-tree-warnings.js';

const registry = buildCoreBlockRegistry();

describe('unknown list item fields', () => {
  it('reports an item key that the list field does not declare', () => {
    const issues = unknownItemFields({ id: 'b', type: 'core/accordion', data: { items: [{ title: 'A', content: 'x', link_rel: 'nofollow' }] } }, registry);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'unknown_field', block_id: 'b', path: 'data.items[0].link_rel', key: 'link_rel' });
  });

  it('accepts declared item fields and checks only the written keys', () => {
    expect(unknownItemFields({ type: 'core/tabs', data: { labels: [{ label: 'P', href: '/', link_rel: 'nofollow sponsored', new_tab: true }] } }, registry)).toEqual([]);
    expect(unknownItemFields({ type: 'core/accordion', data: { items: [{ bogus: 1 }], headline: 'x' } }, registry, { keys: ['headline'] })).toEqual([]);
  });

  it('suggests the closest item field', () => {
    const [issue] = unknownItemFields({ type: 'core/tabs', data: { labels: [{ lable: 'P' }] } }, registry);
    expect(issue!.suggestions).toContain('label');
  });

  it('warns in tree writes, nested blocks included', () => {
    const warnings = blockTreeWarnings([{ id: 'c', type: 'core/container', data: {}, children: [{ id: 'a', type: 'core/accordion', data: { items: [{ title: 'A', extra: 1 }] } }] }]);
    expect(warnings.find(warning => warning.code === 'unknown_field' && warning.key === 'extra')?.path).toBe('blocks[0].children[0].data.items[0].extra');
  });
});
