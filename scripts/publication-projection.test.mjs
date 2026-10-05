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

test('a declared-public browser key in app config does not fail the credential guard', () => {
  // M26 acceptance point 6. publicAppsSnapshot copies only each app's declared
  // public_keys, so a value reaching `apps` has already been declared safe to
  // ship to every visitor — which is exactly what this guard enforces.
  const key = 'AIza' + 'b'.repeat(35);
  const publicRuntime = {
    apps: { apps: { integrations: { enabled: true, config: { google_places__browser_key: key } } } },
    extensions: { installations: [] },
    dependencies: [],
  };
  const value = projectStaticPublication({
    site: { name: 'Example' }, settings: {}, apps: publicRuntime.apps, publicRuntime,
    pages: [{ id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks: [] }],
    partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], blockTypes: [], redirects: [],
  }, identity);
  assert.equal(value.apps.apps.integrations.config.google_places__browser_key, key);
});

test('a browser key in ordinary page content still fails the credential guard', () => {
  // The exemption is for declared-public configuration, not for the key shape.
  const key = 'AIza' + 'c'.repeat(35);
  assert.throws(() => projectStaticPublication({
    site: { name: 'Example' }, settings: {},
    pages: [{ id: 'home', title: key, slug: '', status: 'published', content_mode: 'blocks', blocks: [] }],
    partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], blockTypes: [], redirects: [],
  }, identity), /Credential-like value/);
});

test('publication carries the site render version so builds keep its output', () => {
  const base = { site: { name: 'Example' }, pages: [], partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], blockTypes: [], redirects: [] };
  assert.equal(projectStaticPublication({ ...base, settings: { render_version: 2 } }, identity).settings.render_version, 2);
  assert.equal(projectStaticPublication({ ...base, settings: {} }, identity).settings.render_version, undefined);
  assert.throws(() => projectStaticPublication({ ...base, settings: { render_version: '2' } }, identity), /render_version/);
});

test('publication carries the site style library with structured values only', () => {
  const base = { site: { name: 'Example' }, pages: [], partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], blockTypes: [], redirects: [] };
  const style = { id: 'eyebrow', name: 'Eyebrow', targets: ['text'], base: { size: '0.8rem', weight: 700, border: { width: '1px', color: 'primary' }, secret: 'x' }, at: { desktop: { size: '1rem' } }, private_note: 'x' };
  const projected = projectStaticPublication({ ...base, settings: { styles: [style] } }, identity).settings.styles[0];
  assert.deepEqual(projected, { id: 'eyebrow', name: 'Eyebrow', targets: ['text'], base: { size: '0.8rem', weight: 700, border: { width: '1px', color: 'primary' } }, at: { desktop: { size: '1rem' } } });
  assert.throws(() => projectStaticPublication({ ...base, settings: { styles: {} } }, identity), /styles/);
});

test('publication carries site-specific responsive widths', () => {
  const base = { site: { name: 'Example' }, pages: [], partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], blockTypes: [], redirects: [] };
  const widths = { tablet: 576, laptop: 769, desktop: 1024, wide: 1280 };
  assert.deepEqual(projectStaticPublication({ ...base, settings: { responsive_breakpoints: widths } }, identity).settings.responsive_breakpoints, widths);
});

test('publication carries composed block types, their scoped CSS and link props', async () => {
  const { BLOCK_TYPE_STARTERS } = await import('data:text/javascript;base64,' + Buffer.from((await build({ stdin: { contents: "export { BLOCK_TYPE_STARTERS } from './packages/shared/src/block-type-starters.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })).outputFiles[0].text).toString('base64'));
  const iconList = { ...BLOCK_TYPE_STARTERS[0].definition, id: 'icon_list', css_scope: 'block', origin: 'user', container: false };
  const page = { id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks: [{ id: 'why', type: 'icon_list', data: { items: [{ icon: 'phone', title: 'Call', text: 'Now', link: { page_id: 'contact', new_tab: true } }] } }] };
  const value = projectStaticPublication({ site: { name: 'Example' }, settings: {}, pages: [page], partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], redirects: [], blockTypes: [iconList] }, identity);
  const type = value.blockTypes.find(candidate => candidate.id === 'icon_list');
  assert.equal(type.css_scope, 'block');
  assert.equal(type.composition[0].data.items, '{{props.items}}');
  assert.equal(type.composition[0].children[0].data.href, '{{item.link.href}}');
  assert.equal(type.schema[0].item_label, 'title');
  assert.deepEqual(value.pages[0].blocks[0].data.items[0].link, { page_id: 'contact', new_tab: true });
});

test('publication keeps per-step button labels and multi-step navigation options', () => {
  const form = {
    id: 'lead', name: 'Lead', submit_text: 'Send', submit_url: 'https://forms.example.invalid/submit', submit_token: 'public-token', allow_back: false, show_progress: 'bar',
    steps: [{ id: 'one', title: 'Contact', submit_label: 'Next →', blocks: [] }, { id: 'two', blocks: [] }],
  };
  const base = { site: { name: 'Example' }, settings: {}, pages: [], partials: [], media: [], forms: [], extensions: [], contentTypes: [], pageTemplates: [], blockTypes: [], redirects: [] };
  const [projected] = projectStaticPublication({ ...base, publicRuntime: { forms: [form] } }, identity).forms;
  assert.equal(projected.allow_back, false);
  assert.equal(projected.show_progress, 'bar');
  assert.equal(projected.steps[0].submit_label, 'Next →');
  assert.equal(projected.steps[1].submit_label, undefined);
  assert.throws(() => projectStaticPublication({ ...base, publicRuntime: { forms: [{ ...form, show_progress: 'loud' }] } }, identity), /show_progress/);
});
