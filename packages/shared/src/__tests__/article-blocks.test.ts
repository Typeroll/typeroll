import type { Block } from '../types.js';
import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, CORE_BLOCK_TYPES } from '../core-blocks.js';
import { renderBlock, renderBlocks, renderPageBody, composePageWithTemplate } from '../render-blocks.js';
import { prepareHeadingOutline } from '../heading-outline.js';
import { getPageTemplateStarter } from '../page-template-starters.js';
const registry = buildCoreBlockRegistry();

describe('article content blocks', () => {
  it('renders table cells, spans, credits and validated presentation', () => {
    const html = renderBlock({ id: 'table', type: 'core/table', data: {
      caption: 'Budget', source: '<a href="/source">Source</a>',
      rows: [{ cells: [{ html: 'Cost', header: true, colspan: 2, background: '#008800' },
        { html: '<strong>10</strong>', color: 'red;position:fixed', width: '30%' }] }],
    } }, { registry });
    expect(html).toContain('<caption>Budget</caption>');
    expect(html).toContain('<th colspan="2"');
    expect(html).toContain('background:#008800;');
    expect(html).toContain('width:30%');
    expect(html).not.toContain('position:fixed');
    expect(html).toContain('<strong>10</strong>');
    expect(html).toContain('href="/source"');
  });
  it('preserves explicit image size, mobile source and formatted credit', () => {
    const html = renderBlock({ id: 'photo', type: 'core/image', data: {
      src: '/large.png', mobile_src: '/small.png', original_width: 600, original_height: 300,
      width: 'original', caption_html: '<a href="/credit">Photographer</a>', link: '/offer',
    } }, { registry });
    expect(html).toContain('max-width:min(100%,600px)');
    expect(html).toContain('srcset="/small.png"');
    expect(html).toContain('width="600" height="300"');
    expect(html).toContain('href="/credit"');
    expect(html).toContain('href="/offer"');
  });
  it('renders page blocks instead of stale HTML and preserves legacy heading anchors', () => {
    const options = { registry, context: { page: { content_mode: 'blocks', body: 'stale', blocks: [
      { id: 'h', type: 'core/heading', data: { text: 'Budget', level: 'h2', anchor_id: 'legacy-budget' } },
      { id: 'l', type: 'core/list', data: { ordered: true, start: 3, items: [{ html: '<a href="/x">Plan</a>' }] } },
    ] } } };
    const html = renderPageBody(options);
    expect(html).not.toContain('stale');
    expect(html).toContain('id="legacy-budget"');
    expect(html).toContain('<ol start="3"><li><a href="/x">Plan</a></li></ol>');
    const toc = renderBlock({ id: 'toc', type: 'core/table_of_contents', data: {} }, options);
    expect(toc).toContain('href="#legacy-budget"');
  });
  it('prevents a body slot in its own body from recursing', () => {
    expect(renderPageBody({ registry, context: { page: { content_mode: 'blocks', blocks: [
      { id: 'slot', type: 'template_content_slot', data: {} },
    ] } } })).not.toContain('undefined');
  });
  it('keeps static post cards populated even in an article context', () => {
    const html = renderBlock({ id: 'cards', type: 'core/repeater', data: {
      source_type: 'static', item_block: 'core/post_card', cols: '3',
      items: [{ title: 'Contracts', excerpt: '📜', href: '/contracts/', show_image: false }],
    } }, { registry, context: { page: { title: 'Parent', url: '/parent' } } });
    expect(html).toContain('href="/contracts/"');
    expect(html).toContain('Contracts');
    expect(html).toContain('📜');
    expect(html).not.toContain('Parent');
  });
});

it('preserves semantic wrapper attributes without accepting event handlers or injected attributes', () => {
  const html = renderBlock({ id: 'wrapper', type: 'core/container', data: {
    tag: 'section', layout: 'flow', css_class: 'original-layout', html_id: 'content',
    attributes: [{ name: 'data-layout', value: 'wide" onclick="evil()' }, { name: 'onclick', value: 'evil()' }, { name: 'role', value: 'region' }],
  }, children: [{ id: 'child', type: 'core/rich_heading', data: { level: 'h2', html: 'A <em>formatted</em> heading', anchor_id: 'old-heading' } }] }, { registry });
  expect(html).toContain('data-layout="wide&quot; onclick=&quot;evil()"');
  expect(html).not.toContain(' onclick="evil()"');
  expect(html).toContain('role="region"');
  expect(html).toContain('<section');
  expect(html).toContain('data-block="semantic-container"');
  expect(html).toContain('class="original-layout"');
  expect(html).toContain('id="old-heading"');
  expect(html).toContain('A <em>formatted</em> heading');
});

it('registers each core block exactly once', () => {
  expect(CORE_BLOCK_TYPES.map(block => block.id)).toEqual([...new Set(CORE_BLOCK_TYPES.map(block => block.id))]);
});

it('keeps an inline heading index derived from current nested Page blocks and chosen levels', () => {
  const toc = { id: 'toc', type: 'core/table_of_contents', data: { levels: 'h2', source_field: 'obsolete' } };
  const page: { content_mode: string; obsolete: string; blocks: Block[] } = { content_mode: 'blocks', obsolete: '<h2>Stale field</h2>', blocks: [toc,
    { id: 'section', type: 'core/container', data: {}, children: [
      { id: 'a', type: 'core/heading', data: { text: 'Packing', level: 'h2', anchor_id: 'old-packing' } },
      { id: 'b', type: 'core/heading', data: { text: 'Glass', level: 'h3' } },
    ] },
  ] };
  const html = renderPageBody({ registry, context: { page } });
  const nav = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav).toContain('href="#old-packing">Packing');
  expect(nav).not.toContain('Glass');
  expect(nav).not.toContain('Stale field');
  page.blocks[1]!.children![0]!.data.text = 'Updated packing';
  expect(renderPageBody({ registry, context: { page } })).toContain('href="#old-packing">Updated packing');
  page.blocks.splice(1);
  expect(renderPageBody({ registry, context: { page } })).toContain('data-empty="true"');
  const schema = registry.get('core/table_of_contents')!.schema;
  expect(schema.some(field => ['source_field', 'html', 'body', 'items'].includes(field.name))).toBe(false);
});


it('keeps a template index scoped to the current Page body across edits', () => {
  const template = [...getPageTemplateStarter('article')!,
    { id: 'related-heading', type: 'core/heading', data: { text: 'Related articles', level: 'h2' } },
  ];
  const page = { title: 'Article', content_mode: 'blocks', blocks: [
    { id: 'a', type: 'core/heading', data: { text: 'Packing', level: 'h2', anchor_id: 'packing' } },
    { id: 'b', type: 'core/heading', data: { text: 'Glass', level: 'h3' } },
    { id: 'c', type: 'core/heading', data: { text: 'Detail', level: 'h4' } },
  ] };
  const render = () => prepareHeadingOutline(renderBlocks(composePageWithTemplate(template, page.blocks), { registry, context: { page } })).html;
  const index = () => render().match(/<nav[^>]*data-block="table_of_contents"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(index()).toContain('href="#packing">Packing');
  expect(index()).toContain('href="#glass">Glass');
  expect(index()).not.toContain('Detail');
  expect(index()).not.toContain('Related articles');
  page.blocks[0]!.data.text = 'New packing';
  expect(index()).toContain('href="#packing">New packing');
  page.blocks.splice(0);
  expect(index()).toContain('data-empty="true"');
  expect(index()).not.toContain('<li');
});
