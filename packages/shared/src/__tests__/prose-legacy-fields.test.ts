import { expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, unknownBlockDataFields, type Block } from '../index';

it('recognizes legacy prose presentation fields and preserves their original units', () => {
  const registry = buildCoreBlockRegistry();
  const block: Block = { id: 'legacy', type: 'core/prose', data: { html: '<p>Copy</p>', font_size: 20, paragraph_spacing: 1.5 } };
  expect(unknownBlockDataFields(block, registry)).toEqual([]);
  const html = renderBlocks([block], { registry });
  expect(html).toContain('--font_size:20px');
  expect(html).toContain('--paragraph_spacing:1.5em');
  expect(html).not.toContain('--paragraph_spacing_px:1.5px');
  expect(block.data).toEqual({ html: '<p>Copy</p>', font_size: 20, paragraph_spacing: 1.5 });
});
