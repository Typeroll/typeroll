// Block data keys no field declares (block-unknown-fields.ts).
//
// The check is only safe if it never rejects a key the renderer reads. The
// last block of tests proves that for every core block: rendering its sample
// data reads no undeclared key, its templates read none, and no name the
// renderer source reads from block data is live without being known.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  RENDER_VERSIONS,
  UNDECLARED_BLOCK_DATA_KEYS,
  blockOutputForVersion,
  blockTreeWarnings,
  buildCoreBlockRegistry,
  closestFieldNames,
  collectBlockAssets,
  knownBlockDataKeys,
  renderBlocks,
  sampleBlockData,
  unknownBlockDataFields,
  unknownBlockFields,
  unknownTreeFields,
  type Block,
  type BlockType,
} from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const core = buildCoreBlockRegistry();
const siteType = (type: Partial<BlockType> & { id: string }): BlockType => ({
  name: type.id.split('/')[1]!, label: type.id, category: 'content', container: false, schema: [],
  origin: 'user', created_at: '2026-01-01T00:00:00Z', ...type,
});
const withTypes = (...types: BlockType[]) => new Map([...core, ...types.map(type => [type.id, type] as const)]);

describe('unknown block data keys', () => {
  it('points a repeater key that belongs to the item block at item_overrides', () => {
    const repeater: Block = { id: 'related-list', type: 'core/repeater', data: { source_type: 'related', item_block: 'core/post_card', placeholder_background: '#eee' } };
    expect(unknownBlockDataFields(repeater, core)).toEqual([expect.objectContaining({
      code: 'unknown_field', block_id: 'related-list', block_type: 'core/repeater', path: 'data.placeholder_background',
      key: 'placeholder_background', suggestions: ['item_overrides.placeholder_background'],
    })]);
    expect(unknownBlockDataFields(repeater, core)[0]!.message).toContain('Did you mean item_overrides.placeholder_background?');
    // The item block may come from the stored data while the write sets only the key.
    expect(unknownBlockDataFields(repeater, core, { keys: ['placeholder_background'] })[0]!.suggestions).toEqual(['item_overrides.placeholder_background']);
  });

  it('resolves aliases: their own fields, the repeater fields and the default item block', () => {
    expect(unknownBlockDataFields({ type: 'core/testimonials', data: { items: [], item_overrides: { rating: 5 }, layout: 'grid', show_dots: false } }, core)).toEqual([]);
    expect(unknownBlockDataFields({ type: 'core/testimonials', data: { rating: 5 } }, core)[0]!.suggestions).toEqual(['item_overrides.rating']);
    expect(unknownBlockDataFields({ type: 'core/page_list', data: { placeholder_color: 'red' } }, core)[0]!.suggestions).toEqual(['item_overrides.placeholder_color']);
    // An explicit item block wins over the alias default.
    expect(unknownBlockDataFields({ type: 'core/page_list', data: { item_block: 'core/testimonial', rating: 5 } }, core)[0]!.suggestions).toEqual(['item_overrides.rating']);
  });

  it('suggests the closest field names, or the style override with that name', () => {
    expect(unknownBlockDataFields({ type: 'core/heading', data: { levle: 'h2' } }, core)[0]!.suggestions).toContain('level');
    expect(unknownBlockDataFields({ type: 'core/heading', data: { custom_class: 'x' } }, core)[0]!.suggestions).toEqual(['style_overrides.custom_class']);
    expect(unknownBlockDataFields({ type: 'core/heading', data: { zzz_unrelated_setting: 1 } }, core)[0]!.message).toContain('read_block_type lists its fields');
    expect(closestFieldNames('background', ['placeholder_background', 'level'])).toEqual(['placeholder_background']);
  });

  it('checks only the written keys when given', () => {
    const block = { type: 'core/heading', data: { text: 'A', legacy_key: 1, new_key: 2 } };
    expect(unknownBlockDataFields(block, core, { keys: ['text', 'new_key'] }).map(issue => issue.key)).toEqual(['new_key']);
  });

  it('walks children and slots with request-relative paths', () => {
    const section: Block = { id: 's', type: 'core/section', data: {}, children: [{ id: 'h', type: 'core/heading', data: { text: 'A', colour: 'red' } }] };
    expect(unknownBlockFields(section, core).map(issue => issue.path)).toEqual(['block.children[0].data.colour']);
    const columns: Block = { id: 'c', type: 'core/columns', data: {}, slots: [[], [{ id: 'p', type: 'core/prose', data: { htm: '<p>x</p>' } }]] };
    expect(unknownTreeFields([columns], core).map(issue => issue.path)).toEqual(['blocks[0].slots[1][0].data.htm']);
  });

  it('reports unknown keys in tree writes as warnings', () => {
    const warnings = blockTreeWarnings([{ id: 'r', type: 'core/repeater', data: { item_block: 'core/post_card', placeholder_background: '#eee' } }]);
    expect(warnings).toEqual([expect.objectContaining({ code: 'unknown_field', path: 'blocks[0].data.placeholder_background', suggestions: ['item_overrides.placeholder_background'] })]);
  });

  it('skips block types the registry does not know and extension blocks', () => {
    expect(unknownBlockDataFields({ type: 'user/missing', data: { anything: 1 } }, core)).toEqual([]);
    const extension = siteType({ id: 'ext/map', extension: { extension_id: 'e', installation_id: 'i', component_id: 'c', render_mode: 'bundled_component' } });
    expect(unknownBlockDataFields({ type: 'ext/map', data: { anything: 1 } }, withTypes(extension))).toEqual([]);
  });

  it('knows what a site block type reads without declaring it', () => {
    const banner = siteType({
      id: 'user/banner', schema: [{ name: 'title', type: 'text', label: 'Title' }],
      template: '<div>{{title}}{{{subtitle_html}}}{{#each rows}}{{label}}{{/each}}{{#link cta}}Go{{/link}}{{^empty}}x{{/empty}}{{page.title}}</div>',
      render_versions: [{ from: 7, template: '<div>{{=tag}}</div>' }],
    });
    const registry = withTypes(banner);
    const known = knownBlockDataKeys(banner, registry)!;
    for (const key of ['title', 'subtitle_html', 'rows', 'label', 'cta', 'empty', 'tag', 'responsive_breakpoints']) expect(known.has(key)).toBe(true);
    expect(known.has('page')).toBe(false);
    expect(unknownBlockDataFields({ type: 'user/banner', data: { titel: 'x' } }, registry)[0]!.suggestions).toEqual(['title']);

    const card = siteType({ id: 'user/card', schema: [{ name: 'heading', type: 'text', label: 'Heading' }], composition: [{ id: 'h', type: 'core/heading', data: { text: '{{props.headline}}' } }] });
    expect(knownBlockDataKeys(card, withTypes(card))!.has('headline')).toBe(true);

    const gate = siteType({ id: 'user/gate', container: 'conditional', schema: [{ name: 'condition', type: 'text', label: 'Condition' }] });
    expect(knownBlockDataKeys(gate, withTypes(gate), { condition: "show_banner && page.kind === 'post' || !hide" })).toEqual(new Set(['responsive_breakpoints', 'condition', 'show_banner', 'hide']));
  });

  it('renders a site block type that never declares responsive_breakpoints with it', () => {
    const plain = siteType({ id: 'user/plain', template: '<div class="plain">x</div>' });
    const html = renderBlocks([{ id: 'p', type: 'user/plain', data: { responsive_breakpoints: { tablet: 900, laptop: 1100, desktop: 1300, wide: 1600 } }, hidden_on: ['tablet'] }], { registry: withTypes(plain) });
    expect(html).toContain('min-width: 900px');
    expect(Object.keys(UNDECLARED_BLOCK_DATA_KEYS)).toEqual(['responsive_breakpoints']);
  });
});

describe('the check never rejects a key the renderer reads', () => {
  const types = [...core.values()].sort((a, b) => a.id.localeCompare(b.id));
  const context = { site: { name: 'Site' }, page: { id: 'p', title: 'Page', body: '<h2>Body</h2>', language: 'en' } } as never;
  const sampleBlock = (type: BlockType, data: Record<string, unknown> = sampleBlockData(type.schema)): Block => {
    const block: Block = { id: 'sample', type: type.id, data, hidden_on: ['tablet'] };
    if (type.container === true || type.container === 'conditional') block.children = [{ id: 'child', type: 'core/prose', data: { html: '<p>Child</p>' } }];
    if (type.container === 'slots') block.slots = Array.from({ length: type.slot_count ?? type.slot_labels?.length ?? 2 }, () => []);
    return block;
  };
  const output = (block: Block, renderVersion: number) =>
    renderBlocks([block], { registry: core, renderVersion, context }) + collectBlockAssets([block], core, { renderVersion }).css;

  it('accepts the sample data of every core block', () => {
    const issues = types.flatMap(type => unknownBlockFields(sampleBlock(type), core));
    expect(issues).toEqual([]);
  });

  it('reads only known keys while rendering every core block at every render version', () => {
    const unknownReads: string[] = [];
    for (const type of types) {
      for (const { version } of RENDER_VERSIONS) {
        const data = sampleBlockData(type.schema);
        const known = knownBlockDataKeys(type, core, data)!;
        const recorded = new Proxy(data, {
          get(target, key, receiver) {
            if (typeof key === 'string' && !known.has(key) && !Object.hasOwn(Object.prototype, key)) unknownReads.push(`${type.id}.${key}@v${version}`);
            return Reflect.get(target, key, receiver);
          },
        });
        output(sampleBlock(type, recorded), version);
      }
    }
    // A condition naming a data key reads it; the check knows condition names.
    expect(unknownReads.filter(read => !read.startsWith('template/show_if.'))).toEqual([]);
    const showIf = core.get('template/show_if')!;
    const condition = sampleBlockData(showIf.schema).condition;
    expect(knownBlockDataKeys(showIf, core, { condition })!.has(String(condition))).toBe(true);
  }, 60_000); // Renders every core block many times; the full CI gate runs in parallel.

  it('templates read no undeclared block data: every other name they use is set by the renderer', () => {
    const live: string[] = [];
    for (const type of types) {
      const known = knownBlockDataKeys(type, core)!;
      const names = new Set<string>();
      for (const { version } of RENDER_VERSIONS) {
        for (const match of (blockOutputForVersion(type, version).template ?? '').matchAll(/\{\{\{?\s*(?:[#^=]\s*)?(?:(?:each|link)\s+)?([A-Za-z_][\w.-]*)/g)) {
          const root = match[1]!.split('.')[0]!;
          if (!known.has(root) && !['page', 'site', 'item', 'props', 'content_type', 'collection', 'children'].includes(root)) names.add(root);
        }
      }
      for (const name of names) {
        for (const { version } of RENDER_VERSIONS) {
          if (output(sampleBlock(type), version) !== output(sampleBlock(type, { ...sampleBlockData(type.schema), [name]: 'ZZ-SENTINEL' }), version)) {
            live.push(`${type.id}.${name}@v${version}`);
            break;
          }
        }
      }
    }
    expect(live).toEqual([]);
  }, 60_000); // Renders every core block many times; the full CI gate runs in parallel.

  it('no name the renderer source reads from block data changes a core block without being known', () => {
    // Every `data.<name>`-style read in the shared renderer sources.
    const sources = readdirSync(resolve(HERE, '..')).filter(file => file.endsWith('.ts'))
      .map(file => readFileSync(resolve(HERE, '..', file), 'utf8')).join('\n');
    const names = new Set([...sources.matchAll(/\b(?:data|d|flatData|item)\??\.([a-z_][a-z0-9_]*)/g)].map(match => match[1]!));
    const latest = RENDER_VERSIONS[RENDER_VERSIONS.length - 1]!.version;
    const live: string[] = [];
    for (const type of types) {
      const known = knownBlockDataKeys(type, core)!;
      const base = output(sampleBlock(type), latest);
      for (const name of names) {
        if (known.has(name)) continue;
        for (const value of ['ZZ-SENTINEL', true, 7]) {
          if (output(sampleBlock(type, { ...sampleBlockData(type.schema), [name]: value }), latest) !== base) {
            live.push(`${type.id}.${name}`);
            break;
          }
        }
      }
    }
    expect(names.size).toBeGreaterThan(100);
    expect(live).toEqual([]);
  }, 60_000); // Renders every core block many times; the full CI gate runs in parallel.
});
