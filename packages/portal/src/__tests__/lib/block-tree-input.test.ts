import { describe, expect, it } from 'vitest';
import { blockTreeInputError } from '../../lib/block-tree-input';

describe('blockTreeInputError', () => {
  it('rejects top-level responsive data recursively', () => {
    const error = blockTreeInputError([{
      id: 'columns', type: 'core/columns', data: {}, slots: [[{
        id: 'nested', type: 'core/heading', data: {}, responsive: { mobile: { data_overrides: { size: 'sm' } } },
      }]],
    }]);
    expect(error).toContain('blocks[0].slots[0][0].responsive');
    expect(error).toContain('.data');
  });

  it('accepts responsive values inside block data', () => {
    expect(blockTreeInputError([{
      id: 'grid', type: 'core/grid', data: { cols: { mobile: 1, desktop: 3 } },
    }])).toBeNull();
  });
});
