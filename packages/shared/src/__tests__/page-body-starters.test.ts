import { describe, expect, it } from 'vitest';
import { LATEST_RENDER_VERSION, PAGE_BODY_STARTER_KINDS, blockTreeError, buildCoreBlockRegistry, getPageBodyStarter, renderBlocks, type Block } from '../index.js';

const registry = buildCoreBlockRegistry();
const flatten = (blocks: Block[]): Block[] => blocks.flatMap(block => [block, ...flatten(block.children ?? []), ...(block.slots ?? []).flatMap(flatten)]);

describe('page body starters', () => {
  for (const kind of PAGE_BODY_STARTER_KINDS) {
    it(`${kind} uses only known core blocks, fields and options`, () => {
      const blocks = getPageBodyStarter(kind);
      expect(blockTreeError(blocks, 'blocks', true)).toBeNull();
      for (const block of flatten(blocks)) {
        const type = registry.get(block.type);
        expect(type, block.type).toBeDefined();
        const fields = new Map(type!.schema.map(field => [field.name, field]));
        for (const [key, value] of Object.entries(block.data)) {
          const field = fields.get(key);
          expect(field, `${block.type}.${key}`).toBeDefined();
          if (field?.options && typeof value === 'string') expect(field.options.map(option => typeof option === 'object' ? (option as { value: string }).value : option), `${block.type}.${key}`).toContain(value);
        }
      }
      const html = renderBlocks(blocks, { registry, renderVersion: LATEST_RENDER_VERSION });
      expect(html).not.toContain('[object Object]');
      expect(html).toContain('[');
    });
  }

  it('has one h1-level title and ends with a call to action', () => {
    for (const kind of PAGE_BODY_STARTER_KINDS) {
      const blocks = flatten(getPageBodyStarter(kind));
      const titles = blocks.filter(block => block.type === 'core/hero' || (block.type === 'core/heading' && block.data.level === 'h1'));
      expect(titles, kind).toHaveLength(1);
      expect(getPageBodyStarter(kind).at(-1)?.type, kind).toBe('core/cta');
    }
  });

  it('includes a comparison table and a plan table where they belong', () => {
    expect(flatten(getPageBodyStarter('comparison_page')).some(block => block.type === 'core/table')).toBe(true);
    expect(flatten(getPageBodyStarter('pricing_page')).some(block => block.type === 'core/pricing_table')).toBe(true);
  });

  it('returns a fresh copy each time', () => {
    const first = getPageBodyStarter('feature_page');
    first[0]!.data.heading = 'Changed';
    expect(getPageBodyStarter('feature_page')[0]!.data.heading).not.toBe('Changed');
  });
});
