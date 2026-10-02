// Unit tests for the pure half of lib/block-type-migration.ts: planning a
// schema change with explicit renames, and moving block data accordingly.

import { describe, expect, it } from 'vitest';
import type { Block, BlockType, FieldDefinition } from '@typeroll/shared';
import {
  migrateProps,
  migrateTree,
  planChangesData,
  planSchemaChange,
  renameCompositionBindings,
} from '../../lib/block-type-migration';

const oldSchema: FieldDefinition[] = [
  { name: 'title', type: 'text', label: 'Title' },
  { name: 'count', type: 'text', label: 'Count' },
  { name: 'note', type: 'text', label: 'Note' },
  { name: 'items', type: 'array', label: 'Items', fields: [
    { name: 'label', type: 'text', label: 'Label' },
    { name: 'icon', type: 'icon', label: 'Icon' },
  ] },
];
const newSchema: FieldDefinition[] = [
  { name: 'heading', type: 'textarea', label: 'Heading' },
  { name: 'count', type: 'number', label: 'Count' },
  { name: 'entries', type: 'array', label: 'Entries', fields: [
    { name: 'text', type: 'text', label: 'Text' },
    { name: 'icon', type: 'icon', label: 'Icon' },
  ] },
];
const renames = { title: 'heading', items: 'entries', 'items.label': 'text' };

describe('planSchemaChange', () => {
  it('reports renames at any depth, removals and incompatible type changes', () => {
    const plan = planSchemaChange(oldSchema, newSchema, renames);
    expect(plan.problems).toEqual([]);
    expect(plan.renamed).toEqual([
      { from: 'title', to: 'heading' },
      { from: 'items', to: 'entries' },
      { from: 'items.label', to: 'entries.text' },
    ]);
    expect(plan.removed).toEqual(['note']);
    // text → textarea keeps the value; text → number does not.
    expect(plan.retyped).toEqual([{ path: 'count', from: 'text', to: 'number' }]);
    expect(planChangesData(plan)).toBe(true);
    expect(planChangesData(planSchemaChange(oldSchema, oldSchema))).toBe(false);
  });

  it('refuses renames that name no field, point nowhere, or collide', () => {
    const paths = (r: Record<string, string>, next = newSchema) => planSchemaChange(oldSchema, next, r).problems.map(p => p.path);
    expect(paths({ ...renames, missing: 'x' })).toContain('/renames/missing');
    expect(paths({ ...renames, title: 'nowhere' })).toContain('/renames/title');
    expect(paths({ ...renames, title: 'Bad Name' })).toContain('/renames/title');
    // Renaming a field the new schema still has is not a rename.
    expect(paths({ title: 'heading' }, [...newSchema, { name: 'title', type: 'text', label: 'T' }])).toContain('/renames/title');
    // Two old fields cannot become one.
    expect(paths({ note: 'heading', title: 'heading' })).toEqual(['/renames/note']);
  });
});

describe('migrateProps', () => {
  const plan = planSchemaChange(oldSchema, newSchema, renames);

  it('moves renamed data, inside lists too, drops removed data and keeps unknown keys', () => {
    const result = migrateProps({
      title: 'Hello', count: '3', note: '', extra: 'kept',
      items: [{ label: 'One', icon: 'star' }, { label: 'Two' }],
    }, oldSchema, plan);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ heading: 'Hello', extra: 'kept', entries: [{ text: 'One', icon: 'star' }, { text: 'Two' }] });
    // Only data that held something counts as lost.
    expect(result.lost).toEqual(['count']);
  });

  it('swaps two fields without losing either', () => {
    const schema: FieldDefinition[] = [{ name: 'a', type: 'text', label: 'A' }, { name: 'b', type: 'text', label: 'B' }];
    const swap = planSchemaChange(schema, schema, { a: 'b', b: 'a' });
    expect(swap.problems).toEqual([]);
    expect(migrateProps({ a: 1, b: 2 }, schema, swap).value).toEqual({ a: 2, b: 1 });
  });

  it('leaves untouched props as the same object', () => {
    const value = { other: 1 };
    expect(migrateProps(value, oldSchema, plan)).toEqual({ value, changed: false, lost: [] });
  });
});

describe('migrateTree', () => {
  const plan = planSchemaChange(oldSchema, newSchema, renames);
  const gallery: BlockType = { id: 'gallery_alias', name: 'gallery_alias', label: 'G', category: 'media', container: false, schema: [], created_at: '',
    expand_to: { target: 'core/repeater', defaults: { item_block: 'card' } } };
  const resolve = (id: string) => (id === 'gallery_alias' ? gallery : undefined);

  it('migrates instances, responsive overrides and repeater items rendered with the type', () => {
    const tree: Block[] = [
      { id: 's', type: 'core/section', data: {}, children: [
        { id: 'c1', type: 'card', data: { title: 'A' }, responsive: { mobile: { title: 'a' } } as Block['responsive'] },
      ] },
      { id: 'r', type: 'core/repeater', data: { item_block: 'card', source_type: 'static', items: [{ title: 'B' }, { title: 'C' }] } },
      { id: 'g', type: 'gallery_alias', data: { items: [{ title: 'D' }] } },
      { id: 'cols', type: 'core/columns', data: {}, slots: [[{ id: 'c2', type: 'card', data: { note: 'gone' } }], []] },
    ];
    const result = migrateTree(tree, 'card', oldSchema, plan, resolve);
    expect(result.changed).toBe(true);
    expect(result.instances).toBe(5);
    expect(result.lost).toEqual(['note']);
    expect(result.blocks[0]!.children![0]).toMatchObject({ data: { heading: 'A' }, responsive: { mobile: { heading: 'a' } } });
    expect(result.blocks[1]!.data.items).toEqual([{ heading: 'B' }, { heading: 'C' }]);
    expect(result.blocks[2]!.data.items).toEqual([{ heading: 'D' }]);
    expect(result.blocks[3]!.slots![0]![0]!.data).toEqual({});
    // The input tree is not modified.
    expect(tree[0]!.children![0]!.data).toEqual({ title: 'A' });
  });

  it('reports no change for a tree without the type', () => {
    const tree: Block[] = [{ id: 'h', type: 'core/heading', data: { title: 'x' } }];
    expect(migrateTree(tree, 'card', oldSchema, plan)).toMatchObject({ changed: false, instances: 0 });
  });
});

describe('renameCompositionBindings', () => {
  it('rewrites a composed type\'s own props and item bindings', () => {
    const plan = planSchemaChange(oldSchema, newSchema, renames);
    const composition: Block[] = [
      { id: 'h', type: 'core/heading', data: { text: '{{props.title}}', level: 'h2' } },
      { id: 'list', type: 'core/repeater', data: { source_type: 'static', items: '{{props.items}}' }, children: [
        { id: 't', type: 'core/text', data: { text: '{{item.label}}' } },
        { id: 'i', type: 'core/icon', data: { icon: '{{item.icon}}' } },
      ] },
    ];
    const next = renameCompositionBindings(composition, plan);
    expect(next[0]!.data.text).toBe('{{props.heading}}');
    expect(next[1]!.data.items).toBe('{{props.entries}}');
    expect(next[1]!.children![0]!.data.text).toBe('{{item.text}}');
    expect(next[1]!.children![1]!.data.icon).toBe('{{item.icon}}');
  });
});
