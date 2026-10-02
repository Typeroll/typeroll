import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPE_STARTERS,
  buildCoreBlockRegistry,
  renderBlocks,
  validateBlockTypeDefinition,
  type Block,
  type BlockType,
  type FieldDefinition,
} from '@typeroll/shared';
import {
  bindingOptions,
  compositionCssHints,
  compositionFromSelection,
  describeBinding,
  detachComposedInstance,
  detectRenames,
  itemScopeFor,
  parseBinding,
  propCandidates,
  propFieldFrom,
  renameBindings,
  schemaChanges,
  suggestFieldName,
  suggestTypeName,
  templateCompletions,
  templateCssHints,
  writableDefinition,
} from '../../lib/block-type-builder';
import { arrayItemTitle, arrayLimits, duplicateArrayItem, moveArrayItem, newArrayItem, removeArrayItem } from '../../lib/array-field-ops';
import { addBlockTo, duplicateBlockIn, findBlockIn, moveBlockIn, replaceBlockIn } from '../../lib/block-tree-ops';

const registry = buildCoreBlockRegistry();

const section: Block = {
  id: 'cta', name: 'CTA section', type: 'core/section', data: { padding_y: 'lg' }, children: [
    { id: 'cta-h', type: 'core/heading', data: { text: 'Book a call', level: 'h2' } },
    { id: 'cta-p', type: 'core/prose', data: { html: '<p>We answer within a day.</p>' } },
    { id: 'cta-b', type: 'core/button', data: { label: 'Contact us', href: '/contact' } },
  ],
};

function registerType(type: BlockType): Map<string, BlockType> {
  const next = new Map(registry);
  next.set(type.id, type);
  return next;
}

describe('turning a selection into a composed block type', () => {
  it('offers the content fields of every inner block, with unique names', () => {
    const candidates = propCandidates(section, registry);
    expect(candidates.map(c => [c.blockId, c.field.name, c.name])).toEqual([
      ['cta-h', 'text', 'heading'],
      ['cta-p', 'html', 'text'],
      ['cta-b', 'label', 'button'],
      ['cta-b', 'href', 'button_link_to'],
    ]);
    expect(candidates[0]!.value).toBe('Book a call');
  });

  it('skips values that are empty, responsive or already bound', () => {
    const root: Block = { id: 'r', type: 'core/container', data: {}, children: [
      { id: 'a', type: 'core/heading', data: { text: '' } },
      { id: 'b', type: 'core/heading', data: { text: '{{props.title}}' } },
      { id: 'c', type: 'core/text', data: { text: { mobile: 'Hi', desktop: 'Hello' } } },
    ] };
    expect(propCandidates(root, registry)).toEqual([]);
  });

  it('binds the chosen fields, keeps the others fixed and carries the original values', () => {
    const { composition, schema, data } = compositionFromSelection(section, [
      { blockId: 'cta-h', fieldName: 'text', name: 'title', label: 'Title' },
      { blockId: 'cta-b', fieldName: 'href', name: 'link', label: 'Button link' },
    ], registry);
    expect(composition[0]!.children![0]!.data.text).toBe('{{props.title}}');
    expect(composition[0]!.children![1]!.data.html).toBe('<p>We answer within a day.</p>');
    expect(composition[0]!.children![2]!.data.href).toBe('{{props.link}}');
    expect(composition[0]!.name).toBeUndefined();
    expect(schema).toEqual([
      { name: 'title', type: 'text', label: 'Title' },
      { name: 'link', type: 'url', label: 'Button link' },
    ]);
    expect(data).toEqual({ title: 'Book a call', link: '/contact' });
    // The source tree is unchanged.
    expect(section.children![0]!.data.text).toBe('Book a call');
  });

  it('produces a definition the shared validator accepts and that renders the same text', () => {
    const { composition, schema, data } = compositionFromSelection(section, propCandidates(section, registry)
      .map(c => ({ blockId: c.blockId, fieldName: c.field.name, name: c.name, label: c.label })), registry);
    const definition = { name: 'cta_section', label: 'CTA section', category: 'custom', schema, composition };
    const result = validateBlockTypeDefinition(definition, { resolveType: id => registry.get(id) });
    expect(result.problems.filter(p => p.severity === 'error')).toEqual([]);
    const type = { ...result.merged, id: 'cta_section', origin: 'user', created_at: '' } as BlockType;
    const html = renderBlocks([{ id: 'inst', type: 'cta_section', data }], { registry: registerType(type) });
    expect(html).toContain('Book a call');
    expect(html).toContain('We answer within a day.');
    expect(html).toContain('href="/contact"');
  });

  it('refuses a name used twice', () => {
    expect(() => compositionFromSelection(section, [
      { blockId: 'cta-h', fieldName: 'text', name: 'title', label: 'A' },
      { blockId: 'cta-b', fieldName: 'label', name: 'title', label: 'B' },
    ], registry)).toThrow(/used twice/);
  });

  it('copies only the field properties block types accept', () => {
    const inner: FieldDefinition = { name: 'cols', type: 'number', label: 'Columns', min: 1, max: 6, responsive: true, css_unit: 'number', required: true, default: 3 } as FieldDefinition;
    expect(propFieldFrom(inner, 'columns', 'Columns')).toEqual({ name: 'columns', type: 'number', label: 'Columns', min: 1, max: 6 });
  });
});

describe('detaching a composed block', () => {
  const starter = BLOCK_TYPE_STARTERS.find(s => s.id === 'icon_list')!;
  const iconList = { ...starter.definition, id: 'icon_list', container: false, origin: 'user', created_at: '' } as BlockType;

  it('replaces props bindings with the instance values and resolves item links', () => {
    const instance: Block = { id: 'i1', type: 'icon_list', data: { items: [
      { icon: 'phone', title: 'Call', text: 'Mon–Fri', link: { page_id: 'contact' } },
      { icon: 'mail', title: 'Write', text: 'Any time' },
    ] } };
    let n = 0;
    const blocks = detachComposedInstance(instance, iconList, id => id === 'contact' ? '/contact/' : undefined, () => `new_${++n}`);
    expect(blocks).toHaveLength(1);
    const repeater = blocks[0]!;
    expect(repeater.type).toBe('core/repeater');
    expect(repeater.id).toBe('new_1');
    const items = repeater.data.items as Array<Record<string, unknown>>;
    expect(items[0]!.title).toBe('Call');
    expect((items[0]!.link as { href: string }).href).toBe('/contact/');
    expect(items[0]).not.toHaveProperty('icon_svg');
    // Item bindings stay: the repeater fills them per item on the page.
    expect(repeater.children![0]!.data.href).toBe('{{item.link.href}}');

    const html = renderBlocks(blocks, { registry, renderVersion: 4 });
    expect(html).toContain('href="/contact/"');
    expect(html).toContain('Write');
  });
});

describe('bindings', () => {
  const schema: FieldDefinition[] = [
    { name: 'title', type: 'text', label: 'Title' },
    { name: 'cta', type: 'link', label: 'Call to action' },
    { name: 'items', type: 'array', label: 'Items', fields: [
      { name: 'heading', type: 'text', label: 'Heading' },
      { name: 'link', type: 'link', label: 'Link' },
    ] },
  ];

  it('parses whole-value bindings only', () => {
    expect(parseBinding('{{props.title}}')).toEqual({ namespace: 'props', path: ['title'] });
    expect(parseBinding(' {{ item.link.href }} ')).toEqual({ namespace: 'item', path: ['link', 'href'] });
    expect(parseBinding('Hello {{props.title}}')).toBeNull();
    expect(parseBinding('{{page.title}}')).toBeNull();
  });

  it('offers compatible fields, item fields first inside a repeater', () => {
    const text: FieldDefinition = { name: 'text', type: 'text', label: 'Text' };
    expect(bindingOptions(text, { props: schema, item: schema[2]!.fields, itemLabel: 'Items' }).map(o => o.value)).toEqual([
      '{{item.heading}}', '{{item.link.href}}', '{{props.title}}', '{{props.cta.href}}',
    ]);
    const newTab: FieldDefinition = { name: 'new_tab', type: 'boolean', label: 'New tab' };
    expect(bindingOptions(newTab, { props: schema }).map(o => o.value)).toEqual(['{{props.cta.new_tab}}']);
    const items: FieldDefinition = { name: 'items', type: 'array', label: 'Items' };
    expect(bindingOptions(items, { props: schema }).map(o => o.label)).toEqual(['Items']);
  });

  it('describes a binding by its labels', () => {
    expect(describeBinding({ namespace: 'item', path: ['link', 'href'] }, { props: schema, item: schema[2]!.fields, itemLabel: 'Items' })).toBe('Items › Link (address)');
    expect(describeBinding({ namespace: 'props', path: ['gone'] }, { props: schema })).toBe('gone (missing field)');
  });

  it('finds the item fields of the repeater around a block', () => {
    const composition: Block[] = [{ id: 'list', type: 'core/repeater', data: { items: '{{props.items}}' }, children: [
      { id: 'card', type: 'core/container', data: {}, children: [{ id: 'h', type: 'core/heading', data: {} }] },
    ] }, { id: 'after', type: 'core/text', data: {} }];
    expect(itemScopeFor(composition, 'h', schema)?.fields.map(f => f.name)).toEqual(['heading', 'link']);
    expect(itemScopeFor(composition, 'h', schema)?.label).toBe('Items');
    expect(itemScopeFor(composition, 'list', schema)).toBeUndefined();
    expect(itemScopeFor(composition, 'after', schema)).toBeUndefined();
  });
});

describe('definitions and schema changes', () => {
  it('keeps only writable properties and drops the unused kind', () => {
    const out = writableDefinition({ id: 'x', name: 'x', label: 'X', origin: 'user', created_at: 'now', css_scope: 'block', schema: [], composition: [{ id: 'a', type: 'core/text', data: {} }], template: '', container: false, script: '', item_compatible: true, expand_to: undefined } as Partial<BlockType>);
    expect(out).toEqual({ name: 'x', label: 'X', schema: [], composition: [{ id: 'a', type: 'core/text', data: {} }], item_compatible: true });
    expect(writableDefinition({ name: 'y', label: 'Y', schema: [], template: '<p></p>', container: 'repeater', composition: [] })).toEqual({ name: 'y', label: 'Y', schema: [], template: '<p></p>', container: 'repeater' });
  });

  it('lists removed, added and retyped fields, inside groups too', () => {
    const before: FieldDefinition[] = [
      { name: 'title', type: 'text', label: 'T' },
      { name: 'items', type: 'array', label: 'I', fields: [{ name: 'heading', type: 'text', label: 'H' }, { name: 'n', type: 'number', label: 'N' }] },
    ];
    const after: FieldDefinition[] = [
      { name: 'headline', type: 'text', label: 'T' },
      { name: 'items', type: 'array', label: 'I', fields: [{ name: 'title', type: 'text', label: 'H' }, { name: 'n', type: 'text', label: 'N' }] },
    ];
    expect(schemaChanges(before, after)).toEqual({ removed: ['title', 'items.heading'], added: ['items.title', 'headline'], retyped: ['items.n'] });
  });

  it('detects fields renamed in place and moves the composition bindings with them', () => {
    const before: FieldDefinition[] = [
      { name: 'title', type: 'text', label: 'T' },
      { name: 'items', type: 'array', label: 'I', fields: [{ name: 'heading', type: 'text', label: 'H' }, { name: 'link', type: 'link', label: 'L' }] },
    ];
    const after: FieldDefinition[] = [
      { name: 'headline', type: 'text', label: 'T' },
      { name: 'benefits', type: 'array', label: 'I', fields: [{ name: 'title', type: 'text', label: 'H' }, { name: 'link', type: 'link', label: 'L' }] },
    ];
    const renames = detectRenames(before, after);
    expect(renames).toEqual({ title: 'headline', items: 'benefits', 'items.heading': 'benefits.title' });
    // A swap of two names, or a changed type, is not a rename.
    expect(detectRenames([{ name: 'a', type: 'text', label: 'A' }, { name: 'b', type: 'text', label: 'B' }], [{ name: 'b', type: 'text', label: 'A' }, { name: 'a', type: 'text', label: 'B' }])).toEqual({});
    expect(detectRenames([{ name: 'a', type: 'text', label: 'A' }], [{ name: 'c', type: 'number', label: 'A' }])).toEqual({});

    const composition: Block[] = [
      { id: 'h', type: 'core/heading', data: { text: '{{props.title}}' } },
      { id: 'list', type: 'core/repeater', data: { items: '{{props.items}}' }, children: [
        { id: 'card', type: 'core/container', data: { href: '{{item.link.href}}' }, children: [{ id: 't', type: 'core/heading', data: { text: '{{item.heading}}' } }] },
      ] },
    ];
    const moved = renameBindings(composition, renames);
    expect(moved[0]!.data.text).toBe('{{props.headline}}');
    expect(moved[1]!.data.items).toBe('{{props.benefits}}');
    expect(moved[1]!.children![0]!.data.href).toBe('{{item.link.href}}');
    expect(moved[1]!.children![0]!.children![0]!.data.text).toBe('{{item.title}}');
    expect(composition[0]!.data.text).toBe('{{props.title}}');
  });

  it('suggests valid unique names', () => {
    expect(suggestFieldName('Button link', [])).toBe('button_link');
    expect(suggestFieldName('Title', ['title'])).toBe('title_2');
    expect(suggestFieldName('2 columns', [])).toBe('field_2_columns');
    expect(suggestFieldName('Icon svg', [])).toBe('icon_text');
    expect(suggestFieldName('Item', [])).toBe('item_text');
    expect(suggestTypeName('Café cards!', ['cafe_cards'])).toBe('cafe_cards_2');
  });
});

describe('editor hints', () => {
  it('collects classes and inner block selectors for the CSS tab', () => {
    const hints = compositionCssHints([{ id: 'a', type: 'core/container', data: { css_class: 'card card--wide' }, children: [{ id: 'h', type: 'core/heading', data: {} }] }], registry);
    expect(hints.map(h => h.selector ?? `.${h.className}`)).toEqual(['.card', '.card--wide', '[data-block="container"]', '[data-block="heading"]']);
    expect(templateCssHints('<ul class="list {{#x}}list--x{{/x}}"><li class="list__item">').map(h => h.className)).toEqual(['list', 'list--x', 'list__item']);
  });

  it('completes field names and sections at the cursor', () => {
    const schema: FieldDefinition[] = [
      { name: 'title', type: 'text', label: 'Title' },
      { name: 'items', type: 'array', label: 'Items', fields: [{ name: 'icon', type: 'icon', label: 'Icon' }, { name: 'link', type: 'link', label: 'Link' }] },
    ];
    expect(templateCompletions(schema, '<h2>{{ti')).toEqual({ from: 6, items: [{ label: 'title', insert: 'title}}', detail: 'Title' }] });
    expect(templateCompletions(schema, '<h2>title')).toBeNull();
    expect(templateCompletions(schema, '{{#ea')!.items.map(i => i.label)).toEqual(['#each items']);
    const inLoop = templateCompletions(schema, '{{#each items}}<li>{{')!.items.map(i => i.label);
    expect(inLoop[0]).toBe('/each');
    expect(inLoop).toContain('icon');
    expect(inLoop).toContain('{icon_svg}');
    expect(inLoop).toContain('link.href');
    expect(inLoop).toContain('@index');
    expect(templateCompletions(schema, '{{#each items}}{{{ic')!.items.map(i => i.label)).toEqual(['{icon_svg}']);
    expect(templateCompletions(schema, '{{{ic')!.items).toEqual([]);
  });
});

describe('array items', () => {
  const field: FieldDefinition = { name: 'items', type: 'array', label: 'Items', item_label: 'title', min_items: 1, max_items: 3, fields: [
    { name: 'title', type: 'text', label: 'Title' },
    { name: 'icon', type: 'icon', label: 'Icon', default: 'check' },
  ] };

  it('titles items by item_label, falling back to the position', () => {
    expect(arrayItemTitle(field, { title: '<b>Fast</b> delivery' }, 0)).toBe('Fast delivery');
    expect(arrayItemTitle(field, { title: '' }, 1)).toBe('Item 2');
    expect(arrayItemTitle({ ...field, item_label: undefined }, { title: 'First text field' }, 0)).toBe('First text field');
    expect(arrayItemTitle({ name: 'l', type: 'array', label: 'L', item_label: 'link', fields: [{ name: 'link', type: 'link', label: 'Link' }] }, { link: { page_id: 'x' } }, 0)).toBe('Page link');
  });

  it('creates, duplicates, moves and removes items', () => {
    expect(newArrayItem(field)).toEqual({ icon: 'check' });
    const list = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];
    expect(moveArrayItem(list, 0, 2).map(i => i.title)).toEqual(['b', 'c', 'a']);
    expect(moveArrayItem(list, 2, 0).map(i => i.title)).toEqual(['c', 'a', 'b']);
    const copy = duplicateArrayItem(list, 1);
    expect(copy.map(i => i.title)).toEqual(['a', 'b', 'b', 'c']);
    expect(copy[2]).not.toBe(list[1]);
    expect(removeArrayItem(list, 1).map(i => i.title)).toEqual(['a', 'c']);
    const keyed = duplicateArrayItem([{ key: 'k1' }], 0, { name: 'x', type: 'array', label: 'X', item_key: 'key' });
    expect(keyed[1]!.key).not.toBe('k1');
  });

  it('applies min_items and max_items', () => {
    expect(arrayLimits(field, 1)).toEqual({ canAdd: true, canRemove: false, hint: '1–3 items' });
    expect(arrayLimits(field, 3)).toMatchObject({ canAdd: false, canRemove: true });
    expect(arrayLimits({ ...field, max_items: undefined }, 0).hint).toBe('At least 1 item');
  });
});

describe('block tree operations', () => {
  const tree: Block[] = [{ id: 'a', type: 'core/container', data: {}, children: [{ id: 'b', type: 'core/text', data: {} }] }, { id: 'c', type: 'core/text', data: {} }];

  it('adds, moves, duplicates and replaces without touching the input', () => {
    const added = addBlockTo(tree, { id: '', type: 'core/heading', data: {} }, 'a', undefined, 0);
    expect(findBlockIn(added.tree, added.addedId)?.parent?.id).toBe('a');
    expect(moveBlockIn(tree, 'c', 'a', undefined, 0)[0]!.children!.map(b => b.id)).toEqual(['c', 'b']);
    expect(moveBlockIn(tree, 'a', 'b', undefined, 0)).toBe(tree);
    const dup = duplicateBlockIn(tree, 'a');
    expect(dup.tree).toHaveLength(3);
    expect(dup.tree[1]!.children![0]!.id).not.toBe('b');
    const replaced = replaceBlockIn(tree, 'b', [{ id: 'x', type: 'core/text', data: {} }, { id: 'y', type: 'core/text', data: {} }]);
    expect(replaced[0]!.children!.map(b => b.id)).toEqual(['x', 'y']);
    expect(tree[0]!.children!.map(b => b.id)).toEqual(['b']);
  });
});
