// Select values outside their options are refused where a write sets or
// changes them (Moveria: `core/rich_heading` saved with `level: 2`, a number,
// which renders a <div>). A value the stored block already holds is not.

import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, invalidFieldValuesBody, invalidSelectValues, type Block } from '../index.js';

const registry = buildCoreBlockRegistry();
const heading = (data: Record<string, unknown>, id = 'h1'): Block => ({ id, type: 'core/rich_heading', data: { html: 'Title', ...data } });

describe('invalidSelectValues', () => {
  it('names the block, field, value and allowed options of a numeric level', () => {
    const issues = invalidSelectValues([heading({ level: 2 })], registry);
    expect(issues).toEqual([{
      block_id: 'h1',
      block_type: 'core/rich_heading',
      path: 'blocks[0].data.level',
      field: 'level',
      value: 2,
      allowed: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      message: 'core/rich_heading block h1: blocks[0].data.level is 2, but level must be one of "h1", "h2", "h3", "h4", "h5", "h6".',
    }]);
    expect(invalidFieldValuesBody(issues)).toEqual({
      error: `${issues[0]!.message} Nothing was written.`,
      code: 'invalid_field_value',
      details: { invalid_fields: issues },
    });
  });

  it('accepts listed options, numeric text for numeric options and empty values', () => {
    expect(invalidSelectValues([heading({ level: 'h2', font_weight: 600, align: { mobile: 'center', desktop: '' } })], registry)).toEqual([]);
  });

  it('keeps an unchanged stored value and refuses a changed one', () => {
    const stored = [heading({ level: 2 })];
    expect(invalidSelectValues([heading({ level: 2, html: 'New title' })], registry, { stored })).toEqual([]);
    expect(invalidSelectValues([heading({ level: 3 })], registry, { stored })).toEqual([
      expect.objectContaining({ block_id: 'h1', field: 'level', value: 3 }),
    ]);
    // Another block, or one without an id, is new: checked whole.
    expect(invalidSelectValues([heading({ level: 2 }, 'h2')], registry, { stored })).toHaveLength(1);
    expect(invalidSelectValues([{ type: 'core/rich_heading', data: { html: 'x', level: 2 } }], registry, { stored })).toHaveLength(1);
  });

  it('checks breakpoints, nested children and route overrides', () => {
    const tree: Block[] = [{
      id: 's', type: 'core/section', data: {},
      children: [heading({ align: { mobile: 'middle' } })],
    }, {
      ...heading({ level: 'h2' }, 'h2'),
      route_overrides: { home: { data_overrides: { level: 'h7' } } },
    }];
    expect(invalidSelectValues(tree, registry).map(issue => issue.path)).toEqual([
      'blocks[0].children[0].data.align.mobile',
      'blocks[1].route_overrides.home.data_overrides.level',
    ]);
    const stored = structuredClone(tree);
    expect(invalidSelectValues(tree, registry, { stored })).toEqual([]);
  });

  it('checks one block without its descendants on request', () => {
    const block: Block = { id: 's', type: 'core/section', data: {}, children: [heading({ level: 2 })] };
    expect(invalidSelectValues(block, registry, { root: 'block' }).map(issue => issue.path)).toEqual(['block.children[0].data.level']);
    expect(invalidSelectValues(block, registry, { root: 'block', descendants: false })).toEqual([]);
  });

  it('leaves other type mismatches to the field_type_mismatch warning', () => {
    expect(invalidSelectValues([heading({ color: 12 })], registry)).toEqual([]);
  });
});
