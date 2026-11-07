import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, unknownBlockDataFields, type Block } from '../index.js';

const registry = buildCoreBlockRegistry();

describe('collection item fields', () => {
  it('a feature grid card sets its own link label', () => {
    const grid: Block = { id: 'g', type: 'core/feature_grid', data: { items: [
      { heading: 'Ljus', link: '/ljus/', link_label: 'Boka en ljusstudie' },
      { heading: 'Trä', link: '/tra/' },
    ] } };
    expect(unknownBlockDataFields(grid, registry)).toEqual([]);
    const html = renderBlocks([grid], { registry, renderVersion: 14, context: { site: { language: 'sv' }, page: { language: 'sv' } } as never });
    expect(html).toContain('Boka en ljusstudie');
    expect(html).toContain('Läs mer');
  });
});
