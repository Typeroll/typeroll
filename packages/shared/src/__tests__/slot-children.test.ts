import { describe, expect, it } from 'vitest';
import { SLOT_BLOCK_TYPES, blockTreeWarnings, buildCoreBlockRegistry, ensureBlockIds, type Block } from '../index.js';

describe('children of slot blocks', () => {
  it('names exactly the core block types that render only slots', () => {
    const slotTypes = [...buildCoreBlockRegistry().values()].filter(type => type.container === 'slots').map(type => type.id);
    expect(new Set(slotTypes)).toEqual(SLOT_BLOCK_TYPES);
  });
  it('moves children to the end of the first slot and warns', () => {
    const tree: Block[] = [{ id: 'cols', type: 'core/columns', data: {}, slots: [[{ id: 'a', type: 'core/text', data: {} }], []],
      children: [{ id: 'b', type: 'core/text', data: {} }] }];
    expect(blockTreeWarnings(tree).map(warning => warning.code)).toContain('children_in_slot_block');
    ensureBlockIds(tree);
    expect(tree[0]!.children).toBeUndefined();
    expect(tree[0]!.slots![0]!.map(block => block.id)).toEqual(['a', 'b']);
  });
});
