import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { projectStaticPublication } from './lib/static-publication.mjs';
import { projectPublicationBlocks } from './lib/publication-blocks.mjs';

const bundle = await build({ stdin: { contents: "export { CORE_BLOCK_TYPES } from './packages/shared/src/core-blocks.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { CORE_BLOCK_TYPES } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const identity = { siteUrl: 'https://example.invalid', coreCommit: 'a'.repeat(40), publishedAt: '2026-09-20T12:00:00Z', coreBlockTypes: CORE_BLOCK_TYPES };

test('publication preserves breadcrumb labels separately from Page titles', () => {
  const value = projectStaticPublication({ site: { name: 'Example' }, settings: {}, pages: [{ id: 'tips', title: 'Detailed moving advice', breadcrumb_label: 'Moving tips', content_mode: 'blocks', blocks: [], status: 'published', slug: 'tips' }], partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], blockTypes: [], redirects: [] }, identity);
  assert.equal(value.pages[0].breadcrumb_label, 'Moving tips');
});

test('dynamic Repeater rows preserve public item fields and discard private fields', () => {
  const definitions = [...CORE_BLOCK_TYPES, { id: 'custom-card', schema: [{ name: 'title', type: 'text' }, { name: 'href', type: 'url' }, { name: 'internal', type: 'text', rendered: false }] }];
  const blocks = [{ id: 'list', type: 'core/repeater', data: { source_type: 'static', item_block: 'custom-card', items: [{ title: 'Visible title', href: '/visible/', internal: 'private', unknown: 'private' }], item_overrides: { internal: 'private', title: 'Override' } } }];
  const data = projectPublicationBlocks(blocks, definitions)[0].data;
  assert.deepEqual(data.items, [{ title: 'Visible title', href: '/visible/' }]);
  assert.deepEqual(data.item_overrides, { title: 'Override' });
});

test('native card mappings and aliases retain their explicitly bound static values', () => {
  const blocks = [{ id: 'list', type: 'core/page_list', data: { source_type: 'static', items: [{ title: 'Guide', url: '/guide/', pdf: '/guide.pdf', note: 'private' }], item_overrides: { download_url_field: 'pdf' } } }];
  const data = projectPublicationBlocks(blocks, CORE_BLOCK_TYPES)[0].data;
  assert.deepEqual(data.items, [{ title: 'Guide', url: '/guide/', pdf: '/guide.pdf' }]);
});

test('full source projection cannot reintroduce private fields through card mappings', () => {
  const value = projectStaticPublication({ site: { name: 'Example' }, settings: {}, pages: [{ id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks: [{ id: 'list', type: 'core/repeater', data: { source_type: 'static', item_block: 'custom-card', items: [{ private_title: 'secret', title: 'Public', group: 'Guides' }], group_by: 'group', item_overrides: { title_field: 'private_title' } } }] }], partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], redirects: [], blockTypes: [{ id: 'custom-card', schema: [{ name: 'title', type: 'text' }, { name: 'title_field', type: 'text' }, { name: 'private_title', type: 'text', rendered: false }] }] }, identity);
  assert.deepEqual(value.pages[0].blocks[0].data.items, [{ title: 'Public', group: 'Guides' }]);
  assert.ok(!JSON.stringify(value).includes('secret'));
});
