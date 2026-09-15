import { describe, expect, it } from 'vitest';
import { migrateContentSnapshot, migrateTemplateTokens, unifiedPageIds, type LegacyContentSnapshot } from '../../lib/migrations/unified-pages';
import { buildCoreBlockRegistry, composePageWithTemplate, renderBlocks, pageBodyContext, pageContentValues, contentPagePath } from '@typeroll/shared';
const input = (): LegacyContentSnapshot => ({
  version: 'main', templates: [], pages: [{ id: 'about', title: 'About', slug: 'about', status: 'published', content_mode: 'blocks', blocks: [] }],
  collections: [{ definition: {
    id: 'articles', name: 'articles', label_singular: 'Article', label_plural: 'Articles',
    fields: [{ name: 'title', type: 'text', label: 'Title' }, { name: 'body', type: 'richtext', label: 'Body' }, { name: 'related', type: 'item_ref', ref_collection: 'articles', label: 'Related' }],
    route_template: '/articles/{slug}',
  }, items: [
    { id: 'about', title: 'Article', slug: 'article', body: '<h2 id="old">Title</h2><p>Body</p>', status: 'published', related: 'second' },
    { id: 'second', title: 'Next', slug: 'next', body: '<p>Next</p>', status: 'draft' },
  ] }],
});

describe('unified page migration', () => {
  it('produces one Page entity per source and resolves collisions consistently across versions', () => {
    const main = input(), branch = { ...input(), version: 'branch' };
    branch.collections[0].items[0].title = 'Branch title';
    const ids = unifiedPageIds([main, branch]);
    const output = migrateContentSnapshot(main, ids, '2026-01-01');
    const variant = migrateContentSnapshot(branch, ids, '2026-01-01');
    expect(output.pages).toHaveLength(3);
    expect(new Set(output.pages.map(p => p.id)).size).toBe(3);
    const article = output.pages.find(p => p.content_type === 'articles' && p.slug === 'article')!;
    expect(article.id).not.toBe('about');
    expect(variant.pages.find(p => p.slug === 'article')?.id).toBe(article.id);
    expect(article.fields?.related).toBe('second');
    expect(article.blocks?.[0].data.anchor_id).toBe('old');
    expect(article).not.toHaveProperty('body');
    expect(article.fields).not.toHaveProperty('body');
    expect(contentPagePath(article, output.contentTypes.find(t => t.id === 'articles')!)).toBe('/articles/article');
  });
  it('keeps URL-less content in the same Pages model', () => {
    const source = input(); source.collections[0].definition.route_template = '';
    const result = migrateContentSnapshot(source, unifiedPageIds([source]), '2026-01-01');
    const type = result.contentTypes.find(t => t.id === 'articles')!;
    expect(result.pages.filter(p => p.content_type === type.id)).toHaveLength(2);
    expect(contentPagePath(result.pages[1], type)).toBeNull();
  });
  it('preserves HTML layout and styling once while converting the editable body into blocks', () => {
    const source = input(); source.collections[0].definition.item_template_html = '<main class="article" style="max-width:700px"><h1>{{title}}</h1>{{{body}}}</main>';
    const output = migrateContentSnapshot(source, unifiedPageIds([source]), '2026-01-01');
    expect(output.blockTypes[0].template).toBe('<main class="article" style="max-width:700px"><h1>{{page.title}}</h1>{{children}}</main>');
    expect(output.templates[0].blocks[0].children?.[0].type).toBe('template_content_slot');
    expect(output.pages[1].blocks?.[0].type).toBe('core/heading');
    expect(output).toEqual(migrateContentSnapshot(source, unifiedPageIds([source]), '2026-01-01'));
  });
  it('converts normal HTML pages too and preserves the existing homepage URL', () => {
    const source = input(); Object.assign(source.pages[0], { slug: 'home', content_mode: 'html', html_content: '<h2 id="section">Heading</h2><p>Body</p>' });
    const output = migrateContentSnapshot(source, unifiedPageIds([source]), '2026-01-01');
    expect(output.pages[0]).toMatchObject({ content_type: 'page', content_mode: 'blocks', path: '/', blocks: [{ type: 'core/heading', data: { anchor_id: 'section' } }, { type: 'core/prose' }] });
    expect(output.pages[0]).not.toHaveProperty('html_content');
  });
  it('does not rewrite prose or repeater item bindings when changing template namespaces', () => {
    expect(migrateTemplateTokens('An item.example. {{item.title}} {{collection.label_plural}}')).toBe('An item.example. {{page.title}} {{content_type.label_plural}}');
    expect(migrateTemplateTokens('{{item.title}}', true)).toBe('{{item.title}}');
    const source = input(); source.pages[0].blocks = [{ id: 'r', type: 'core/repeater', data: { source_type: 'collection', collection: 'articles', item_template: '<h2>{{item.title}}</h2>', pinned_ids: ['about'] }, children: [{ id: 'child', type: 'core/heading', data: { text: '{{item.title}}' } }] }];
    const output = migrateContentSnapshot(source, unifiedPageIds([source]), '2026-01-01');
    expect(output.pages[0].blocks?.[0]).toMatchObject({ data: { source_type: 'pages', content_type: 'articles', item_template: '<h2>{{item.title}}</h2>', pinned_ids: [output.pages[1].id] }, children: [{ data: { text: '{{item.title}}' } }] });
  });
  it('reserves type and template identities across every version and remaps nested references', () => {
    const source = input(); source.collections[0].definition.name = 'page';
    source.collections[0].definition.fields = [{ name: 'group', label: 'Group', type: 'object', fields: [{ name: 'link', label: 'Link', type: 'item_ref', ref_collection: 'page' }] }];
    source.collections[0].items[0].group = { link: 'about' };
    const branch = structuredClone(source); branch.version = 'branch'; branch.templates = [{ id: 'content-type-content-page', name: 'existing', label: 'Existing', status: 'published', created_at: '', blocks: [] }];
    const ids = unifiedPageIds([source, branch]);
    const output = migrateContentSnapshot(source, ids, '2026-01-01');
    const variant = migrateContentSnapshot(branch, ids, '2026-01-01');
    expect(output.contentTypes[1].id).toBe('content-page');
    expect(output.contentTypes[1].template).toBe(variant.contentTypes[1].template);
    expect(output.contentTypes[1].template).not.toBe('content-type-content-page');
    expect(output.contentTypes[1].fields[0].fields?.[0]).toMatchObject({ type: 'page_ref', ref_content_type: 'content-page' });
    expect(output.pages[1].fields?.group).toEqual({ link: output.pages[1].id });
  });
  it('rejects duplicate public URLs before a migration is applied', () => {
    const source = input(); source.pages[0].path = '/articles/article';
    expect(() => migrateContentSnapshot(source, unifiedPageIds([source]), '2026-01-01')).toThrow('Duplicate public route');
  });
});

it('separates custom Page template bindings from the same block used by a repeater', () => {
  const source = input();
  source.blockTypes = [{ id: 'outline', name: 'outline', label: 'Outline', category: 'content', container: false, item_compatible: true, schema: [], template: '<aside>{{item.title}}{{{item.toc_html}}}</aside>', created_at: '' }];
  source.collections[0].definition.item_template_blocks = [{ id: 'outline', type: 'outline', data: {} }, { id: 'body', type: 'template/item_body', data: {}, style_overrides: { custom_class: 'original-body' } }];
  source.pages[0].blocks = [{ id: 'list', type: 'core/repeater', data: { item_block: 'outline', source_type: 'static', items: [{ title: 'Card title' }] } }];
  const output = migrateContentSnapshot(source, unifiedPageIds([source]), '2026-01-01');
  const registry = buildCoreBlockRegistry(); for (const type of output.blockTypes) registry.set(type.id, type);
  const page = output.pages.find(page => page.slug === 'article')!;
  const context = { page: { ...pageContentValues(page), ...pageBodyContext('<h2 id="old">Title</h2><p>Body</p>') } };
  const html = renderBlocks(composePageWithTemplate(output.templates[0].blocks, page.blocks!), { registry, context });
  expect(html).toContain('<aside>Article');
  expect(html).toContain('href="#old"');
  expect(html).toContain('original-body');
  const cards = renderBlocks(output.pages[0].blocks!, { registry, context });
  expect(cards).toContain('<aside>Card title');
  expect(cards).not.toContain('<aside>Article');
});
