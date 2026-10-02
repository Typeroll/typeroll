import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { collectBlockAssets, renderBlocks } from '../render-blocks.js';
import type { Block, BlockType } from '../types.js';

const iconList: BlockType = {
  id: 'icon_list', name: 'icon_list', label: 'Icon list', category: 'content', container: false, origin: 'user', css_scope: 'block',
  created_at: '2026-10-02T00:00:00Z',
  schema: [
    { name: 'items', type: 'array', label: 'Items', item_label: 'title', fields: [
      { name: 'icon', type: 'icon', label: 'Icon' },
      { name: 'title', type: 'text', label: 'Heading' },
      { name: 'text', type: 'text', label: 'Text' },
      { name: 'link', type: 'link', label: 'Link' },
    ] },
    { name: 'heading', type: 'text', label: 'Heading', default: 'Why us' },
  ],
  composition: [
    { id: 'title', type: 'core/heading', data: { text: '{{props.heading}}', level: 'h2' } },
    { id: 'list', type: 'core/repeater', data: { source_type: 'static', items: '{{props.items}}', layout: 'list' }, children: [
      { id: 'card', type: 'core/container', data: { tag: 'a', href: '{{item.link.href}}', new_tab: '{{item.link.new_tab}}', padding_y: 'none' }, children: [
        { id: 'icon', type: 'core/icon', data: { icon: '{{item.icon}}' } },
        { id: 'name', type: 'core/heading', data: { text: '{{item.title}}', level: 'h3' } },
        { id: 'line', type: 'core/text', data: { text: '{{item.text}}' } },
      ] },
    ] },
  ],
  styles: ':scope { display: grid; gap: 1rem; }\n.block-text { opacity: .8 }',
};

function registry(...types: BlockType[]) {
  const map = buildCoreBlockRegistry();
  for (const type of types) map.set(type.id, type);
  return map;
}

const pages = [{ id: 'contact', url: '/kontakt/' }];
const pageSource = (config: { ids?: string[] }) => pages.filter(page => config.ids?.includes(page.id));

describe('composed block types', () => {
  const instance: Block = { id: 'why', type: 'icon_list', data: { items: [
    { icon: 'phone', title: 'Call us', text: 'Weekdays 8–17 <b>', link: { page_id: 'contact', new_tab: true } },
    { icon: 'clock', title: 'Fast', text: 'Same day' },
  ] } };

  it('renders the composition with props, item bindings and resolved page links', () => {
    const html = renderBlocks([instance], { registry: registry(iconList), pageSource, renderVersion: 4 });
    expect(html).toMatch(/^<div data-block="icon_list" class="tr-composed">/);
    expect(html).toContain('Why us');
    expect(html).toContain('href="/kontakt/" target="_blank" rel="noopener"');
    expect(html).toContain('Call us');
    // Text from props is escaped, never markup.
    expect(html).toContain('Weekdays 8–17 &lt;b&gt;');
    // The unlinked item is a plain container, and icons never nest links.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<div [^>]*data-block="container"[^>]*>(?:(?!<\/div>).)*Fast/s);
    expect(html).toContain('<svg');
    // Every instance and item gets its own ids.
    expect(html).not.toContain('data-bid="card"');
  });

  it('annotates only the block itself in the editor', () => {
    const html = renderBlocks([instance], { registry: registry(iconList), annotate: true });
    expect(html).toContain('data-block-id="why"');
    expect(html.match(/data-block-id=/g)).toHaveLength(1);
  });

  it('ships the assets of the blocks it is built from, with its own CSS scoped', () => {
    const assets = collectBlockAssets([instance], registry(iconList));
    for (const id of ['core/heading', 'core/repeater', 'core/container', 'core/icon', 'core/text', 'icon_list']) expect(assets.used_ids).toContain(id);
    expect(assets.css).toContain('[data-block="icon_list"]{ display: grid;');
    expect(assets.css).toContain('[data-block="icon_list"] .block-text{');
  });

  it('stops composed blocks that contain themselves', () => {
    const loop: BlockType = { ...iconList, id: 'loop', name: 'loop', composition: [{ id: 'self', type: 'loop', data: {} }] };
    const html = renderBlocks([{ id: 'x', type: 'loop', data: {} }], { registry: registry(loop) });
    expect(html).toContain('nested too deep');
  });

  it('places a composed block inside another one', () => {
    const outer: BlockType = { ...iconList, id: 'outer', name: 'outer', schema: [{ name: 'label', type: 'text', label: 'Label' }],
      composition: [{ id: 'inner', type: 'icon_list', data: { heading: '{{props.label}}', items: [] } }] };
    const html = renderBlocks([{ id: 'o', type: 'outer', data: { label: 'Nested' } }], { registry: registry(iconList, outer) });
    expect(html).toContain('data-block="outer"');
    expect(html).toContain('data-block="icon_list"');
    expect(html).toContain('Nested');
  });
});

describe('template sections', () => {
  const type = (template: string, schema: BlockType['schema'] = []): BlockType => ({
    id: 'site_list', name: 'site_list', label: 'List', category: 'content', container: false, created_at: '2026-10-02T00:00:00Z', origin: 'user', schema, template,
  });
  const items = [{ title: 'One', icon: 'star', link: { url: 'https://example.com' } }, { title: 'Two <i>', icon: 'clock', link: { url: 'javascript:alert(1)' } }];
  const render = (template: string, data: Record<string, unknown>) => renderBlocks([{ id: 'b', type: 'site_list', data }], {
    registry: registry(type(template, [{ name: 'items', type: 'array', label: 'Items', fields: [
      { name: 'title', type: 'text', label: 'Title' }, { name: 'icon', type: 'icon', label: 'Icon' }, { name: 'link', type: 'link', label: 'Link' },
    ] }, { name: 'empty', type: 'text', label: 'Empty' }])),
  });

  it('loops with position values and derived values per item', () => {
    const html = render('<ul>{{#each items}}<li data-n="{{@number}}"{{#@first}} class="first"{{/@first}}>{{{icon_svg}}}{{title}}</li>{{/each}}</ul>', { items });
    expect(html).toContain('<li data-n="1" class="first"><svg');
    expect(html).toContain('<li data-n="2">');
    expect(html).toContain('Two &lt;i&gt;');
  });

  it('wraps in a safe link only when the link resolves', () => {
    const html = render('{{#each items}}{{#link link class="row"}}<span>{{title}}</span>{{/link}}{{/each}}', { items });
    expect(html).toContain('<a href="https://example.com" class="row"><span>One</span></a>');
    expect(html).toContain('<span>Two &lt;i&gt;</span>');
    expect(html).not.toContain('javascript');
  });

  it('renders inverted sections for empty values', () => {
    expect(render('{{#empty}}full{{/empty}}{{^empty}}nothing{{/empty}}', {})).toContain('nothing');
    expect(render('{{^items}}no items{{/items}}', { items: [] })).toContain('no items');
  });

  it('leaves a broken template to the original passes', () => {
    expect(() => render('{{#each items}}<li>{{title}}</li>', { items })).not.toThrow();
  });
});
