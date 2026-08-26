import { describe, it, expect } from 'vitest';
import {
  findBlock,
  addBlock,
  updateBlock,
  moveBlock,
  removeBlock,
  duplicateBlock,
  setBlockResponsiveField,
  BlockMutationError,
} from '../../lib/block-mutations';
import type { Block } from '@typeroll/shared';

const sampleTree: Block[] = [
  {
    id: 'sec1', type: 'core/section', data: { width: 'normal' },
    children: [
      { id: 'h1', type: 'core/heading', data: { text: 'Hi' } },
      { id: 'p1', type: 'core/prose', data: { html: '<p>One</p>' } },
    ],
  },
  {
    id: 'cols', type: 'core/columns', data: { ratio: '1-1' },
    slots: [
      [{ id: 'left1', type: 'core/heading', data: { text: 'L' } }],
      [{ id: 'right1', type: 'core/heading', data: { text: 'R' } }],
    ],
  },
];

describe('findBlock', () => {
  it('finds at top level', () => {
    const r = findBlock(sampleTree, 'sec1');
    expect(r?.block.id).toBe('sec1');
    expect(r?.parent).toBeNull();
  });

  it('finds in children with parent reference', () => {
    const r = findBlock(sampleTree, 'h1');
    expect(r?.block.id).toBe('h1');
    expect(r?.parent?.id).toBe('sec1');
  });

  it('finds inside slots with slot index', () => {
    const r = findBlock(sampleTree, 'right1');
    expect(r?.block.id).toBe('right1');
    expect(r?.parent?.id).toBe('cols');
    expect(r?.parentSlotIndex).toBe(1);
  });

  it('returns null for unknown id', () => {
    expect(findBlock(sampleTree, 'nope')).toBeNull();
  });
});

describe('addBlock', () => {
  it('adds at top level when no parent_id', () => {
    const { blocks, added_id } = addBlock(sampleTree, {
      block: { id: '', type: 'core/button', data: { label: 'Click' } } as Block,
    });
    expect(blocks).toHaveLength(3);
    expect(blocks[2].id).toBe(added_id);
  });

  it('generates an id when missing', () => {
    const { added_id } = addBlock([], {
      block: { id: '', type: 'core/heading', data: {} } as Block,
    });
    expect(added_id).toMatch(/^blk_/);
  });

  it('adds as child of container', () => {
    const { blocks } = addBlock(sampleTree, {
      block: { id: 'new1', type: 'core/prose', data: {} } as Block,
      parent_id: 'sec1',
    });
    const sec = blocks.find((b) => b.id === 'sec1')!;
    expect(sec.children).toHaveLength(3);
    expect(sec.children![2].id).toBe('new1');
  });

  it('adds into a named slot of slot-container', () => {
    const { blocks } = addBlock(sampleTree, {
      block: { id: 'in-r', type: 'core/heading', data: {} } as Block,
      parent_id: 'cols',
      slot_index: 1,
    });
    const cols = blocks.find((b) => b.id === 'cols')!;
    expect(cols.slots![1]).toHaveLength(2);
    expect(cols.slots![1][1].id).toBe('in-r');
  });

  it('respects explicit position', () => {
    const { blocks } = addBlock(sampleTree, {
      block: { id: 'first', type: 'core/prose', data: {} } as Block,
      parent_id: 'sec1',
      position: 0,
    });
    const sec = blocks.find((b) => b.id === 'sec1')!;
    expect(sec.children![0].id).toBe('first');
  });

  it('throws when parent_id missing', () => {
    expect(() =>
      addBlock(sampleTree, {
        block: { id: 'x', type: 'core/prose', data: {} } as Block,
        parent_id: 'ghost',
      }),
    ).toThrow(BlockMutationError);
  });

  it('does not mutate the original tree', () => {
    const before = JSON.stringify(sampleTree);
    addBlock(sampleTree, { block: { id: 'x', type: 'core/prose', data: {} } as Block });
    expect(JSON.stringify(sampleTree)).toBe(before);
  });
});

describe('updateBlock', () => {
  it('shallow-merges data', () => {
    const blocks = updateBlock(sampleTree, {
      block_id: 'h1',
      data: { text: 'Updated', align: 'center' },
    });
    const h = findBlock(blocks, 'h1')!.block;
    expect(h.data.text).toBe('Updated');
    expect(h.data.align).toBe('center');
  });

  it('replaces style_overrides', () => {
    const blocks = updateBlock(sampleTree, {
      block_id: 'h1',
      style_overrides: { html_id: 'hero' },
    });
    expect(findBlock(blocks, 'h1')!.block.style_overrides?.html_id).toBe('hero');
  });

  it('throws on unknown id', () => {
    expect(() => updateBlock(sampleTree, { block_id: 'ghost' })).toThrow(BlockMutationError);
  });

  it('sets and clears the editorial name', () => {
    const named = updateBlock(sampleTree, { block_id: 'h1', name: '  Hero heading  ' });
    expect(findBlock(named, 'h1')!.block.name).toBe('Hero heading'); // trimmed

    const cleared = updateBlock(named, { block_id: 'h1', name: '   ' });
    expect(findBlock(cleared, 'h1')!.block.name).toBeUndefined(); // whitespace clears

    // Omitting name leaves an existing one untouched.
    const kept = updateBlock(named, { block_id: 'h1', data: { text: 'x' } });
    expect(findBlock(kept, 'h1')!.block.name).toBe('Hero heading');
  });
});

describe('moveBlock', () => {
  it('moves a block to top level', () => {
    const blocks = moveBlock(sampleTree, {
      block_id: 'p1',
      target_parent_id: null,
    });
    // p1 no longer under sec1
    const sec = blocks.find((b) => b.id === 'sec1')!;
    expect(sec.children?.find((c) => c.id === 'p1')).toBeUndefined();
    // p1 now at top level
    expect(blocks.find((b) => b.id === 'p1')).toBeTruthy();
  });

  it('moves between slots', () => {
    const blocks = moveBlock(sampleTree, {
      block_id: 'left1',
      target_parent_id: 'cols',
      target_slot_index: 1,
    });
    const cols = blocks.find((b) => b.id === 'cols')!;
    expect(cols.slots![0]).toHaveLength(0);
    expect(cols.slots![1].some((b) => b.id === 'left1')).toBe(true);
  });

  it('rejects moving a block into its own descendant (cycle)', () => {
    expect(() =>
      moveBlock(sampleTree, {
        block_id: 'sec1',
        target_parent_id: 'h1',
      }),
    ).toThrow(/cycle|descendant/i);
  });

  it('throws on unknown id', () => {
    expect(() => moveBlock(sampleTree, { block_id: 'ghost', target_parent_id: null })).toThrow(BlockMutationError);
  });
});

describe('removeBlock', () => {
  it('removes a top-level block', () => {
    const blocks = removeBlock(sampleTree, 'cols');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe('sec1');
  });

  it('removes a deeply nested block', () => {
    const blocks = removeBlock(sampleTree, 'left1');
    const cols = blocks.find((b) => b.id === 'cols')!;
    expect(cols.slots![0]).toHaveLength(0);
  });

  it('throws on unknown id', () => {
    expect(() => removeBlock(sampleTree, 'ghost')).toThrow(BlockMutationError);
  });
});

describe('duplicateBlock', () => {
  it('clones a top-level block and inserts after the original', () => {
    const { tree, duplicate_id } = duplicateBlock(sampleTree, 'sec1');
    expect(tree).toHaveLength(3);                  // sec1, copy, cols
    expect(tree[0].id).toBe('sec1');
    expect(tree[1].id).toBe(duplicate_id);
    expect(tree[1].id).not.toBe('sec1');           // fresh id
    expect(tree[2].id).toBe('cols');
  });

  it('reassigns ids throughout the subtree', () => {
    const { tree } = duplicateBlock(sampleTree, 'sec1');
    const copy = tree[1];
    expect(copy.id).not.toBe('sec1');
    expect(copy.children?.[0].id).not.toBe('h1');
    expect(copy.children?.[1].id).not.toBe('p1');
  });

  it('preserves data + children content (just new ids)', () => {
    const { tree } = duplicateBlock(sampleTree, 'sec1');
    const copy = tree[1];
    expect(copy.type).toBe('core/section');
    expect(copy.data).toEqual({ width: 'normal' });
    expect(copy.children?.[0].data).toEqual({ text: 'Hi' });
  });

  it('duplicates inside a children list', () => {
    const { tree, duplicate_id } = duplicateBlock(sampleTree, 'h1');
    const sec = tree.find((b) => b.id === 'sec1')!;
    expect(sec.children).toHaveLength(3);            // h1, copy, p1
    expect(sec.children![0].id).toBe('h1');
    expect(sec.children![1].id).toBe(duplicate_id);
    expect(sec.children![2].id).toBe('p1');
  });

  it('duplicates inside a slot', () => {
    const { tree, duplicate_id } = duplicateBlock(sampleTree, 'left1');
    const cols = tree.find((b) => b.id === 'cols')!;
    expect(cols.slots![0]).toHaveLength(2);          // original + copy
    expect(cols.slots![0][0].id).toBe('left1');
    expect(cols.slots![0][1].id).toBe(duplicate_id);
    // The other slot is untouched
    expect(cols.slots![1]).toHaveLength(1);
  });

  it('throws on unknown id', () => {
    expect(() => duplicateBlock(sampleTree, 'ghost')).toThrow(BlockMutationError);
  });

  it('does not mutate the input tree', () => {
    const before = JSON.stringify(sampleTree);
    duplicateBlock(sampleTree, 'sec1');
    expect(JSON.stringify(sampleTree)).toBe(before);
  });
});

describe('setBlockResponsiveField', () => {
  it('sets a scalar value when given a scalar', () => {
    const out = setBlockResponsiveField(sampleTree, {
      block_id: 'sec1', field: 'padding_y', value: 'lg',
    });
    const sec = out.find((b) => b.id === 'sec1')!;
    expect(sec.data.padding_y).toBe('lg');
  });

  it('sets a responsive object when given one', () => {
    const out = setBlockResponsiveField(sampleTree, {
      block_id: 'sec1', field: 'padding_y',
      value: { mobile: 'sm', desktop: 'xl' },
    });
    const sec = out.find((b) => b.id === 'sec1')!;
    expect(sec.data.padding_y).toEqual({ mobile: 'sm', desktop: 'xl' });
  });

  it('merges into an existing responsive object', () => {
    // Seed: cols has ratio 1-1 already; set a responsive partial, then
    // add another breakpoint and confirm both keys are present.
    const step1 = setBlockResponsiveField(sampleTree, {
      block_id: 'cols', field: 'gap',
      value: { mobile: 'sm', desktop: 'lg' },
    });
    const step2 = setBlockResponsiveField(step1, {
      block_id: 'cols', field: 'gap',
      value: { tablet: 'md' },
    });
    const cols = step2.find((b) => b.id === 'cols')!;
    expect(cols.data.gap).toEqual({ mobile: 'sm', tablet: 'md', desktop: 'lg' });
  });

  it('promotes a prior scalar to the mobile baseline when going responsive', () => {
    // Seed: sec1.data.width = 'normal' (scalar). Apply a partial bp object
    // that only sets desktop. Expect mobile=normal (inherited) + desktop=wide.
    const out = setBlockResponsiveField(sampleTree, {
      block_id: 'sec1', field: 'width', value: { desktop: 'wide' },
    });
    const sec = out.find((b) => b.id === 'sec1')!;
    expect(sec.data.width).toEqual({ mobile: 'normal', desktop: 'wide' });
  });

  it('collapses a responsive object back to a scalar when given a scalar', () => {
    const step1 = setBlockResponsiveField(sampleTree, {
      block_id: 'sec1', field: 'padding_y',
      value: { mobile: 'sm', desktop: 'xl' },
    });
    const step2 = setBlockResponsiveField(step1, {
      block_id: 'sec1', field: 'padding_y', value: 'md',
    });
    const sec = step2.find((b) => b.id === 'sec1')!;
    expect(sec.data.padding_y).toBe('md');
  });

  // Regression: the tool's `value` is `z.any()`, so a client/LLM can pass the
  // per-breakpoint map as a JSON STRING. Before the fix this hit the scalar
  // branch and was stored verbatim as a string — silently breaking the field
  // (renderer expects an object) and clobbering any prior value.
  it('coerces a JSON-string breakpoint object into an object', () => {
    const out = setBlockResponsiveField(sampleTree, {
      block_id: 'cols', field: 'cols',
      value: '{"mobile":1,"tablet":2,"desktop":4}',
    });
    const cols = out.find((b) => b.id === 'cols')!;
    expect(cols.data.cols).toEqual({ mobile: 1, tablet: 2, desktop: 4 });
  });

  it('merges a JSON-string partial into an existing responsive object', () => {
    const step1 = setBlockResponsiveField(sampleTree, {
      block_id: 'cols', field: 'gap', value: { mobile: 'sm', desktop: 'lg' },
    });
    const step2 = setBlockResponsiveField(step1, {
      block_id: 'cols', field: 'gap', value: '{"tablet":"md"}',
    });
    const cols = step2.find((b) => b.id === 'cols')!;
    expect(cols.data.gap).toEqual({ mobile: 'sm', tablet: 'md', desktop: 'lg' });
  });

  it('leaves a genuine scalar string (e.g. an align token) untouched', () => {
    const out = setBlockResponsiveField(sampleTree, {
      block_id: 'sec1', field: 'width', value: 'wide',
    });
    const sec = out.find((b) => b.id === 'sec1')!;
    expect(sec.data.width).toBe('wide');
  });

  it('leaves an unparseable brace-leading string as a scalar', () => {
    const out = setBlockResponsiveField(sampleTree, {
      block_id: 'sec1', field: 'label', value: '{not json',
    });
    const sec = out.find((b) => b.id === 'sec1')!;
    expect(sec.data.label).toBe('{not json');
  });

  it('throws on unknown id', () => {
    expect(() =>
      setBlockResponsiveField(sampleTree, { block_id: 'ghost', field: 'x', value: 1 }),
    ).toThrow(BlockMutationError);
  });

  it('does not mutate the input tree', () => {
    const before = JSON.stringify(sampleTree);
    setBlockResponsiveField(sampleTree, { block_id: 'sec1', field: 'width', value: 'wide' });
    expect(JSON.stringify(sampleTree)).toBe(before);
  });
});

// Regression: slot containers persisted WITHOUT a `slots` array (the shape
// the production gruppsupporter bisect hit — add_block with parent_id +
// slot_index dropped children into a flat `children` field the renderer
// never reads, so both columns rendered empty).
describe('addBlock — slot containers without a slots array', () => {
  const bareColumns: Block[] = [
    { id: 'cols0', type: 'core/columns', data: { ratio: '1-1' } },
  ];

  it('slot_index lands the child in the right slot even when slots is missing', () => {
    const { blocks } = addBlock(bareColumns, {
      block: { id: '', type: 'core/prose', data: { html: '<p>höger</p>' } } as Block,
      parent_id: 'cols0',
      slot_index: 1,
    });
    const cols = blocks[0];
    expect(cols.children ?? []).toHaveLength(0);
    expect(cols.slots).toBeDefined();
    expect(cols.slots![1]).toHaveLength(1);
    expect(cols.slots![1][0].data.html).toBe('<p>höger</p>');
    // core/columns has arity 2 — slot 0 exists (empty), not just slot 1.
    expect(cols.slots![0]).toEqual([]);
  });

  it('omitting slot_index on a core slot container defaults to slot 0, never children', () => {
    const { blocks } = addBlock(bareColumns, {
      block: { id: '', type: 'core/prose', data: { html: '<p>vänster</p>' } } as Block,
      parent_id: 'cols0',
    });
    const cols = blocks[0];
    expect(cols.children ?? []).toHaveLength(0);
    expect(cols.slots![0][0].data.html).toBe('<p>vänster</p>');
  });

  it('a freshly added bare core/columns gets slots initialised to its arity', () => {
    const { blocks, added_id } = addBlock([], {
      block: { id: '', type: 'core/columns', data: {} } as Block,
    });
    expect(blocks[0].id).toBe(added_id);
    expect(blocks[0].slots).toEqual([[], []]);
  });

  it('core/tabs gets six slots', () => {
    const { blocks } = addBlock([], {
      block: { id: '', type: 'core/tabs', data: {} } as Block,
    });
    expect(blocks[0].slots).toHaveLength(6);
  });

  it('explicit slot_index works on a custom (non-core) slot container instance', () => {
    const tree: Block[] = [{ id: 'cust', type: 'user/fancy_split', data: {} }];
    const { blocks } = addBlock(tree, {
      block: { id: '', type: 'core/prose', data: { html: '<p>x</p>' } } as Block,
      parent_id: 'cust',
      slot_index: 2,
    });
    expect(blocks[0].slots).toHaveLength(3);
    expect(blocks[0].slots![2][0].data.html).toBe('<p>x</p>');
    expect(blocks[0].children ?? []).toHaveLength(0);
  });

  it('plain containers still receive children when no slot signal exists', () => {
    const tree: Block[] = [{ id: 'sec', type: 'core/section', data: {} }];
    const { blocks } = addBlock(tree, {
      block: { id: '', type: 'core/prose', data: { html: '<p>x</p>' } } as Block,
      parent_id: 'sec',
    });
    expect(blocks[0].children).toHaveLength(1);
    expect(blocks[0].slots).toBeUndefined();
  });
});

describe('addBlock — nested subtree payloads', () => {
  it('assigns ids to every block inside an inserted slots subtree', () => {
    const { blocks } = addBlock([], {
      block: {
        type: 'core/columns', data: {},
        slots: [
          [{ type: 'core/prose', data: { html: '<p>L</p>' } }],
          [{ type: 'core/section', data: {}, children: [
            { type: 'core/prose', data: { html: '<p>R</p>' } },
          ] }],
        ],
      } as unknown as Block,
    });
    const ids: string[] = [];
    const walk = (list: Block[]) => {
      for (const b of list) {
        ids.push(b.id);
        if (b.children) walk(b.children);
        for (const s of b.slots ?? []) walk(s);
      }
    };
    walk(blocks);
    expect(ids).toHaveLength(4);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('moveBlock — into slot containers without slots', () => {
  it('moves a stranded child from children into the requested slot', () => {
    // The exact broken state production left behind: columns with a flat
    // children list. moveBlock + target_slot_index is the repair path.
    const broken: Block[] = [
      { id: 'cols', type: 'core/columns', data: {}, children: [
        { id: 'stray', type: 'core/prose', data: { html: '<p>strandad</p>' } },
      ] },
    ];
    const blocks = moveBlock(broken, {
      block_id: 'stray', target_parent_id: 'cols', target_slot_index: 1,
    });
    const cols = blocks[0];
    expect(cols.children ?? []).toHaveLength(0);
    expect(cols.slots![1][0].id).toBe('stray');
  });
});
