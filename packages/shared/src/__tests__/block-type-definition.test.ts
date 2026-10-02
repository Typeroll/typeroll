import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlocks } from '../render-blocks.js';
import { BLOCK_TYPE_STARTERS } from '../block-type-starters.js';
import { referencedBlockTypes, sampleBlockData, validateBlockTypeDefinition } from '../block-type-definition.js';
import type { BlockType } from '../types.js';

const core = buildCoreBlockRegistry();
const resolveType = (id: string) => core.get(id);
const errors = (input: unknown, options: Partial<Parameters<typeof validateBlockTypeDefinition>[1]> = {}) =>
  validateBlockTypeDefinition(input, { resolveType, ...options }).problems.filter(problem => problem.severity === 'error');

describe('block type definitions', () => {
  it('accepts every starter and renders it with sample data', () => {
    for (const starter of BLOCK_TYPE_STARTERS) {
      expect(errors(starter.definition), starter.id).toEqual([]);
      const { merged } = validateBlockTypeDefinition(starter.definition, { resolveType });
      const registry = new Map(core);
      registry.set(merged.name, { ...merged, id: merged.name });
      const html = renderBlocks([{ id: 'x', type: merged.name, data: sampleBlockData(merged.schema) }], { registry, renderVersion: 4 });
      expect(html, starter.id).toContain(`data-block="${merged.name}"`);
      expect(html, starter.id).not.toContain('{{');
    }
  });

  it('warns that an icon inside a linked container nests links before render version 4', () => {
    const iconList = BLOCK_TYPE_STARTERS.find(starter => starter.id === 'icon_list')!.definition;
    const warnings = (renderVersion?: number) => validateBlockTypeDefinition(iconList, { resolveType, renderVersion }).problems
      .filter(problem => problem.severity === 'warning');
    expect(warnings(3)).toEqual([expect.objectContaining({ path: '/composition/0/children/0/data/tag', message: expect.stringContaining('render version 3') })]);
    expect(warnings(4)).toEqual([]);
    expect(warnings(undefined)).toEqual([]);
    // Through a composed type nested in the linked container as well.
    const badge: BlockType = { id: 'badge', name: 'badge', label: 'Badge', category: 'custom', container: false, schema: [], created_at: '',
      composition: [{ id: 'i', type: 'core/icon', data: { icon: 'star' } }] };
    const card = { name: 'card', label: 'Card', schema: [], composition: [{ id: 'a', type: 'core/container', data: { tag: 'a', href: '/x' }, children: [{ id: 'b', type: 'badge', data: {} }] }] };
    const resolveWithBadge = (id: string) => (id === 'badge' ? badge : core.get(id));
    expect(validateBlockTypeDefinition(card, { resolveType: resolveWithBadge, renderVersion: 1 }).problems.map(problem => problem.path)).toEqual(['/composition/0/data/tag']);
  });

  it('scopes stylesheets written from now on', () => {
    expect(validateBlockTypeDefinition(BLOCK_TYPE_STARTERS[0]!.definition, { resolveType }).value.css_scope).toBe('block');
  });

  it('reports unknown properties, bad names and broken fields with their path', () => {
    const problems = errors({ name: 'Bad Name', label: '', category: 'x', schema: [
      { name: 'items', type: 'array', label: 'Items', item_label: 'nope', fields: [{ name: 'icon_svg', type: 'text', label: 'X' }] },
      { name: 'kind', type: 'select', label: 'Kind', options: [] },
      { name: 'kind', type: 'warp', label: 'Again' },
    ], template: '<p></p>', extra: true });
    const paths = problems.map(problem => problem.path);
    expect(paths).toEqual(expect.arrayContaining(['/extra', '/name', '/label', '/category', '/schema/0/item_label', '/schema/0/fields/0/name', '/schema/1/options', '/schema/2/name', '/schema/2/type']));
  });

  it('checks bindings in a composition against the props and list items', () => {
    const base = BLOCK_TYPE_STARTERS[0]!.definition;
    const broken = JSON.parse(JSON.stringify(base)) as BlockType;
    broken.composition![0]!.children![0]!.children![1]!.children![0]!.data.text = '{{item.titel}}';
    broken.composition![0]!.data.items = '{{props.itemz}}';
    const messages = errors(broken).map(problem => problem.message).join('\n');
    expect(messages).toContain('{{props.itemz}} names no field');
    const unknownType = { ...base, composition: [{ id: 'a', type: 'site/missing', data: {} }] };
    expect(errors(unknownType)[0]!.message).toContain('does not exist');
    const self = { ...base, composition: [{ id: 'a', type: 'icon_list', data: {} }] };
    expect(errors(self, { resolveType: (id: string) => id === 'icon_list' ? { ...base, id: 'icon_list' } as BlockType : core.get(id) })[0]!.message).toContain('cannot contain itself');
  });

  it('checks templates: balanced sections, known names and raw output', () => {
    const schema = [{ name: 'items', type: 'array', label: 'Items', fields: [{ name: 'title', type: 'text', label: 'T' }, { name: 'link', type: 'link', label: 'L' }] }, { name: 'intro', type: 'text', label: 'I' }];
    expect(errors({ name: 'list', label: 'List', schema, template: '{{#each items}}{{#link link}}{{title}}{{/link}}{{/each}}<p>{{intro}}</p>' })).toEqual([]);
    expect(errors({ name: 'list', label: 'List', schema, template: '{{#each items}}{{title}}' })[0]!.message).toContain('never closed');
    expect(errors({ name: 'list', label: 'List', schema, template: '<p>{{titel}}</p>' })[0]!.message).toContain('names no field');
    const raw = errors({ name: 'list', label: 'List', schema, template: '<p>{{{intro}}}</p>' });
    expect(raw[0]!.message).toContain('raw HTML');
    expect(errors({ name: 'list', label: 'List', schema, template: '<p>{{@index}}</p>' })[0]!.message).toContain('inside {{#each}}');
  });

  it('accepts the presentation properties core fields use, and needs slot_count for slots', () => {
    const schema = [{ name: 'gap_px', type: 'number', label: 'Gap', css_unit: 'px', responsive: true, responsive_css: { a: '--x: 1;' } }];
    expect(errors({ name: 'cols', label: 'Cols', schema, template: '<div>{{children}}</div>', container: true })).toEqual([]);
    expect(errors({ name: 'cols', label: 'Cols', schema, template: '<div>{{slot:1}}</div>', container: 'slots' })[0]!.path).toBe('/slot_count');
  });

  it('refuses a definition that is both composed and templated, or neither', () => {
    expect(errors({ name: 'x', label: 'X', schema: [] })[0]!.message).toContain('needs a composition');
    expect(errors({ ...BLOCK_TYPE_STARTERS[0]!.definition, template: '<p></p>' }).some(problem => problem.message.includes('not both'))).toBe(true);
  });

  it('refuses page-wide CSS and script without permission', () => {
    const definition = { ...BLOCK_TYPE_STARTERS[0]!.definition, styles: 'body { margin: 0 }', script: 'alert(1)' };
    const messages = errors(definition).map(problem => problem.message).join('\n');
    expect(messages).toContain('styles the whole page');
    expect(messages).toContain('need explicit permission');
    expect(errors(definition, { allowScript: true }).some(problem => problem.path === '/script')).toBe(false);
  });

  it('validates a patch against the stored type', () => {
    const existing = { ...BLOCK_TYPE_STARTERS[0]!.definition, id: 'icon_list', created_at: '', container: false } as BlockType;
    expect(errors({ label: 'Benefits' }, { partial: true, existing })).toEqual([]);
    expect(errors({ name: 'other' }, { partial: true, existing })[0]!.message).toContain('cannot be renamed');
    const legacy = { id: 'legacy', name: 'legacy', label: 'Legacy', category: 'custom', container: false, schema: [], created_at: '' } as BlockType;
    expect(errors({ label: 'Renamed' }, { partial: true, existing: legacy })).toEqual([]);
    expect(errors({ template: '' }, { partial: true, existing: legacy })[0]!.message).toContain('needs a composition');
    // Removing a field the composition reads is caught.
    expect(errors({ schema: [] }, { partial: true, existing })[0]!.message).toContain('names no field');
  });

  it('lists the block types a composition depends on', () => {
    expect(referencedBlockTypes(BLOCK_TYPE_STARTERS[0]!.definition).sort()).toEqual(['core/container', 'core/heading', 'core/icon', 'core/repeater', 'core/text']);
  });
});
