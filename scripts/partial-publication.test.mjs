import test from 'node:test';
import { captureDependencies, trackedMediaLookup, trackedPageSource, trackedBacklinks, recordNavigation, dependenciesMatch } from '../packages/site-template/src/lib/publication-dependencies.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicationBuildHarness } from './lib/publication-build-harness.mjs';
import { createRenderPlan, routeFingerprint, validCacheEntry, readRenderCache, digest } from '../packages/site-template/src/lib/publication-render-cache.mjs';

const page = (id, body = id) => ({ id, slug: id, title: id, status: 'published', content_mode: 'html', html_content: `<h1>${id}</h1><p>${body}</p>` });
const publication = () => ({ format: 'typeroll-static-publication', format_version: 2, publication_id: 'a'.repeat(64),
  core_commit: 'a'.repeat(40), site_url: 'https://example.invalid', version_id: 'main', site: { name: 'Test' },
  settings: { site_name: 'Test', trailing_slash: 'always' }, pages: [page('one'), page('two')],
  media: [], partials: [], contentTypes: [], pageTemplates: [], blockTypes: [], forms: [] });
const manifest = { files: { 'packages/shared/src/index.ts': 'code', 'publication.json': 'source', 'content/pages/one.json': 'body' } };

test('page changes stay local; query and navigation dependencies are replayed separately', () => {
  const value = publication();
  value.pages.push({ ...page('list'), content_mode: 'blocks', blocks: [{ id: 'listing', type: 'core/page_list', data: { content_type: 'page' } }] });
  const baseline = createRenderPlan(value, manifest);
  value.pages[0].html_content += '<p>New body</p>'; value.pages[0].date_updated = '2026-09-18';
  const next = createRenderPlan(value, manifest);
  assert.notEqual(next.keys.one.key, baseline.keys.one.key);
  assert.equal(next.keys.two.key, baseline.keys.two.key);
  assert.equal(next.keys.list.key, baseline.keys.list.key);
  for (const mutate of [
    v => { v.pages[0].title = 'Renamed'; }, v => { v.pages[0].slug = 'new'; },
    v => { v.pages[0].status = 'draft'; }, v => { v.pages.pop(); }, v => { v.pages.push(page('new')); },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.equal(createRenderPlan(changed, manifest).keys.two.key, next.keys.two.key);
  }
  for (const mutate of [
    v => { v.settings.sitewide_noindex = true; }, v => { v.site_url = 'https://new.invalid'; },
    v => { v.version_id = 'redesign'; },
    v => { v.pageTemplates.push({ id: 'template', blocks: [] }); },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.notEqual(createRenderPlan(changed, manifest).keys.two.key, next.keys.two.key);
  }
  assert.notEqual(createRenderPlan(value, { files: { ...manifest.files, 'package-lock.json': 'new' } }).keys.two.key, next.keys.two.key);
  assert.notEqual(createRenderPlan(value, manifest, 'new-runtime').keys.two.key, next.keys.two.key);
  assert.equal(createRenderPlan({ ...value, publication_id: 'b'.repeat(64), published_at: 'later' }, manifest).keys.two.key, next.keys.two.key);
  assert.equal(createRenderPlan({ ...value, source_impact_snapshot: { changed: 'diagnostic' }, media_manifest: { publication_id: 'new' } }, manifest).keys.two.key, next.keys.two.key);
});

test('declarative custom block definitions do not add Page-set dependencies', () => {
  const value = publication();
  value.blockTypes = [{ id: 'custom-card', container: false, schema: [], template: '<p>{{page.title}}</p>' }];
  value.pages[1].blocks = [{ id: 'custom', type: 'custom-card', data: {} }];
  value.partials = [{ blocks: [{ id: 'shared', type: 'custom-card', data: {} }] }];
  const before = createRenderPlan(value, manifest);
  value.pages[0].html_content += 'changed';
  value.media.push({ id: 'unrelated', cdn_url: 'https://media.invalid/unrelated' });
  assert.equal(createRenderPlan(value, manifest).keys.two.key, before.keys.two.key);
  value.blockTypes[0].template = '<aside>{{page.title}}</aside>';
  assert.notEqual(createRenderPlan(value, manifest).keys.two.key, before.keys.two.key);
});

test('media receipts track only looked-up URLs, including misses and deletions', async () => {
  const lookup = { byUrl: new Map([['image', { width: 640, variants: [] }], ['unused', { width: 320 }]]) };
  const { dependencies } = await captureDependencies(async () => {
    const tracked = trackedMediaLookup(lookup);
    assert.equal(tracked.byUrl.get('image').width, 640);
    assert.equal(tracked.byUrl.get('missing'), undefined);
  });
  assert.ok(dependenciesMatch(dependencies, { media: lookup }));
  lookup.byUrl.set('unused', { width: 800 });
  assert.ok(dependenciesMatch(dependencies, { media: lookup }));
  lookup.byUrl.set('missing', { width: 640 });
  assert.ok(!dependenciesMatch(dependencies, { media: lookup }));
  lookup.byUrl.delete('missing'); lookup.byUrl.get('image').variants.push({ width: 320, cdn_url: 'new-variant' });
  assert.ok(!dependenciesMatch(dependencies, { media: lookup }));
  lookup.byUrl.delete('image');
  assert.ok(!dependenciesMatch(dependencies, { media: lookup }));
});

test('route identity, pagination and cache integrity are required for reuse', () => {
  const value = publication(), plan = createRenderPlan(value, manifest), props = { page: value.pages[0] };
  const key = routeFingerprint(plan, '/one/', props);
  const entry = { fingerprint: key, html: '<h1>One</h1>', dependencies: [], dependencyHash: digest([]), sha256: digest('<h1>One</h1>') };
  assert.ok(validCacheEntry(entry, key));
  assert.ok(!validCacheEntry({ ...entry, html: 'corrupted' }, key));
  assert.ok(!validCacheEntry({ ...entry, dependencies: [{ kind: 'query' }] }, key));
  assert.ok(!validCacheEntry(entry, routeFingerprint(plan, '/two/', props)));
  assert.ok(!validCacheEntry(entry, routeFingerprint(plan, '/one/', { ...props, pageNum: 2 })));
  const facetProps = { page: value.pages[1], facet: { filters: [{ field: 'category', value: 'test' }] } };
  const facetKey = routeFingerprint(plan, '/category/test/', facetProps);
  value.pages[0].html_content += 'changed';
  assert.equal(routeFingerprint(createRenderPlan(value, manifest), '/category/test/', facetProps), facetKey);
  assert.equal(readRenderCache(Buffer.from('{broken')), null);
  assert.equal(readRenderCache(Buffer.from('{"format":1,"routes":{}}')), null);
  assert.equal(readRenderCache(Buffer.from('{"format":2,"routes":{}}')), null);
});

test('partial output equals a clean full build after edits, deletion, noindex and origin changes', async t => {
  const value = publication();
  value.contentTypes = [{ id: 'article', name: 'article', label_singular: 'Article', label_plural: 'Articles', fields: [], route_template: '/{slug}' }];
  value.pageTemplates = [{ id: 'article-template', status: 'published', blocks: [
    { id: 'title', type: 'template/page_title', data: {} },
    { id: 'body', type: 'template_content_slot', data: {} },
  ] }];
  value.pages.push(...Array.from({ length: 48 }, (_, i) => page(`article-${i}`)));
  for (const record of value.pages) {
    record.content_type = 'article'; record.content_mode = 'blocks'; record.template = 'article-template';
    record.blocks = [{ id: `${record.id}-text`, type: 'core/prose', data: { html: `<p>${record.id} original body</p>` } }];
    delete record.html_content;
  }
  value.pages.push({ ...page('archive'), content_mode: 'blocks', blocks: [
    { id: 'search', type: 'core/search', data: {} },
    { id: 'listing', type: 'core/repeater', data: { source_type: 'pages', content_type: 'article', item_block: 'core/post_card', paginate: 25, layout: 'grid' } },
  ] });
  const harness = await publicationBuildHarness(value);
  t.after(harness.cleanup);
  const { output, destination } = harness;
  const run = async (full = false) => (await harness.run(full)).report;
  assert.deepEqual(await run(), { format: 1, mode: 'full', rendered: 52, reused: 0, total: 52, removed: 0, reason: 'no_valid_cache' });
  value.pages[0].blocks[0].data.html += '<p>Changed body</p>'; value.pages[0].date_updated = '2026-09-18';
  value.publication_id = 'b'.repeat(64);
  const partial = await run();
  assert.equal(partial.reused, 50); assert.equal(partial.rendered, 2);
  const partialFiles = await output();
  await run(true); assert.deepEqual(await output(), partialFiles);
  assert.equal((await run()).reused, 52);
  async function equivalentPartial() {
    const result = await run();
    const files = await output();
    await run(true);
    assert.deepEqual(await output(), files);
    return result;
  }
  // Insertions create a third archive route without rebuilding unrelated articles.
  const added = { ...structuredClone(value.pages[0]), id: 'added', slug: 'added', title: 'Added' };
  value.pages.push(added);
  let report = await equivalentPartial();
  assert.ok(report.reused >= 48, JSON.stringify(report));
  assert.ok((await output())['archive/page/3/index.html']);
  value.pages.pop();
  report = await equivalentPartial();
  assert.equal(report.removed, 2); // New Page and newly obsolete archive slice.
  assert.ok(report.reused >= 48, JSON.stringify(report));
  // Metadata updates no longer invalidate every page. Navigation, list slices
  // and references are checked separately against their actual reads.
  value.pages[0].title = 'Renamed article';
  report = await equivalentPartial();
  assert.ok(report.reused >= 48, JSON.stringify(report));
  value.pages[0].path = '/nested/åäö';
  report = await equivalentPartial();
  assert.equal(report.removed, 1);
  assert.ok((await output())['nested/åäö/index.html']);
  assert.equal((await equivalentPartial()).reused, 52);
  value.settings.trailing_slash = 'never';
  await equivalentPartial();
  assert.equal((await equivalentPartial()).reused, 52);
  value.pages[0].status = 'draft';
  report = await equivalentPartial();
  assert.equal(report.removed, 1);
  assert.ok(report.reused >= 47, JSON.stringify(report));
  value.pages[0].status = 'published';
  await equivalentPartial();
  // A stale, removed route must never be copied from the previous output.
  value.pages.splice(1, 49); value.settings.sitewide_noindex = true; value.site_url = 'https://new.invalid';
  assert.equal((await run()).removed, 50);
  const removedFiles = await output();
  assert.ok(!removedFiles['two/index.html']);
  assert.ok(!removedFiles['archive/page/2/index.html']);
  await run(true); assert.deepEqual(await output(), removedFiles);
  await fs.writeFile(path.join(destination, '.publication-cache.json'), 'corrupt');
  assert.equal((await run()).reason, 'no_valid_cache');
  assert.deepEqual(await output(), removedFiles);
});


test('recorded queries detect membership, ordering, empty results and only the visited pagination slice', async () => {
  const records = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
  const source = config => records.filter(record => !config.ids || config.ids.includes(record.id));
  const tracked = trackedPageSource(source);
  const { dependencies } = await captureDependencies(async () => {
    const results = tracked({});
    assert.equal(results.length, 3);
    assert.equal(results.slice(0, 1)[0].title, 'A');
    assert.equal(tracked({ ids: ['missing'] }).length, 0);
  });
  const resolvers = { query: source };
  assert.ok(dependenciesMatch(dependencies, resolvers));
  records[2].title = 'Outside the visible slice';
  assert.ok(dependenciesMatch(dependencies, resolvers));
  records[0].title = 'Changed';
  assert.ok(!dependenciesMatch(dependencies, resolvers));
  records[0].title = 'A';
  records.reverse();
  assert.ok(!dependenciesMatch(dependencies, resolvers));
  records.reverse();
  records.push({ id: 'missing', title: 'New member' });
  assert.ok(!dependenciesMatch(dependencies, resolvers));
  assert.ok(!dependenciesMatch([{ kind: 'unknown' }], resolvers));
  assert.ok(!dependenciesMatch(undefined, resolvers));
});

test('reverse references, navigation and concurrent async renders have independent receipts', async () => {
  const index = { a: [{ id: 'b', content_type: 'article' }] };
  const navigation = { next: { id: 'b', title: 'B', url: '/b/' } };
  const [first, second] = await Promise.all([
    captureDependencies(async () => { await Promise.resolve(); trackedBacklinks(index).a; recordNavigation('a', navigation); }),
    captureDependencies(async () => { await Promise.resolve(); trackedBacklinks(index).missing; }),
  ]);
  assert.equal(first.dependencies.length, 2);
  assert.equal(second.dependencies.length, 1);
  const resolvers = { backlinks: index, navigation: () => navigation };
  assert.ok(dependenciesMatch(first.dependencies, resolvers));
  index.a = [];
  assert.ok(!dependenciesMatch(first.dependencies, resolvers));
  assert.ok(dependenciesMatch(second.dependencies, resolvers));
  index.missing = [{ id: 'c', content_type: 'article' }];
  assert.ok(!dependenciesMatch(second.dependencies, resolvers));
});


test('filtered lists, references, backlinks, breadcrumbs and navigation reuse unrelated routes', async t => {
  const value = publication();
  value.contentTypes = [
    { id: 'category', name: 'category', fields: [], route_template: '/{slug}' },
    { id: 'article', name: 'article', sort_field: 'title', sort_dir: 'asc', fields: [
      { name: 'category', type: 'page_ref', label: 'Category', ref_content_type: 'category' },
    ], route_template: '/{slug}' },
    { id: 'page', name: 'page', fields: [{ name: 'refs', type: 'page_ref_list', label: 'Related' }], route_template: '/{slug}' },
  ];
  const blockPage = (id, blocks, extra = {}) => ({ ...page(id), content_mode: 'blocks', blocks, ...extra });
  const listing = (id, data) => ({ id, type: 'core/repeater', data: { item_block: 'core/post_card', content_type: 'article', ...data } });
  const a = blockPage('a', [{ id: 'text', type: 'core/prose', data: { html: '<p>Original</p>' } },
    { id: 'crumbs', type: 'template/page_breadcrumbs', data: {} },
    { id: 'nav', type: 'template/page_navigation', data: {} }], { content_type: 'article', parent: 'cat-a', fields: { category: 'cat-a' } });
  const b = blockPage('b', [], { content_type: 'article', fields: { category: 'cat-b' } });
  value.pages = [a, b,
    blockPage('cat-a', [listing('backlinks', { source_type: 'backlinks' })], { content_type: 'category' }),
    blockPage('cat-b', [], { content_type: 'category' }),
    blockPage('list-a', [listing('query-a', { source_type: 'pages', filter_field: 'category', filter_value: 'cat-a' })]),
    blockPage('list-b', [listing('query-b', { source_type: 'pages', filter_field: 'category', filter_value: 'cat-b' })]),
    blockPage('related', [listing('refs', { source_type: 'related', field: 'refs' })], { fields: { refs: ['a'] } }),
    blockPage('facts', [{ id: 'fields', type: 'core/field_list', data: { fields: [{ field: 'refs' }] } }], { fields: { refs: ['a'] } }),
    page('independent'),
  ];
  const harness = await publicationBuildHarness(value); t.after(harness.cleanup);
  const { run, output, receipts } = harness;
  await run(true);
  async function compare(changed, reused) {
    const { stdout } = await run();
    const entries = await receipts();
    for (const id of changed) assert.equal(entries[`/${id}/`]?.reused, false, `${id} must render`);
    for (const id of reused) {
      assert.equal(entries[`/${id}/`]?.reused, true, `${id} must reuse`);
      assert.ok(!stdout.includes(`/${id}/index.html`), `${id} must be absent from Astro's generation queue`);
    }
    const files = await output(); await run(true); assert.deepEqual(await output(), files);
  }
  a.blocks[0].data.html = '<p>Changed article</p>';
  await compare(['a', 'list-a', 'related', 'cat-a', 'facts'], ['b', 'list-b', 'cat-b', 'independent']);
  a.fields.category = 'cat-b';
  await compare(['a', 'list-a', 'list-b', 'cat-a', 'related'], ['b', 'cat-b', 'independent']);
  value.pages.find(page => page.id === 'cat-a').title = 'Renamed category';
  await compare(['cat-a', 'a'], ['list-b', 'b', 'independent']);
  b.title = 'Updated neighbor';
  await compare(['a', 'b', 'list-b'], ['list-a', 'independent']);
  // An empty list and empty reverse-reference result must subscribe to additions.
  value.pages.push(blockPage('new', [], { content_type: 'article', fields: { category: 'cat-a' } }));
  await compare(['new', 'list-a', 'cat-a'], ['list-b', 'independent']);
  a.status = 'draft';
  await compare(['related', 'facts', 'list-b'], ['list-a', 'independent']);
  assert.ok(!(await output())['a/index.html']);
  // Route-varying shared partials must record queries for every consuming Page.
  value.partials = [{ id: 'footer', kind: 'footer', status: 'published', content_mode: 'blocks', blocks: [
    listing('footer-query', { source_type: 'pages', filter_field: 'category', filter_value: 'cat-b' }),
  ] }];
  await run(true);
  b.title = 'Changed in shared footer';
  await compare(['b', 'independent', 'list-a'], []);
  // Facet routes use the same query capture and never reuse another Page's key.
  value.partials = [];
  value.contentTypes.find(type => type.id === 'article').facets = [{ field: 'category', base_path: '/topics', min_items: 1 }];
  await run(true);
  b.title = 'Changed in facet';
  await compare(['b', 'topics/cat-b'], ['topics/cat-a', 'independent']);
  value.pages = value.pages.filter(page => page.id !== 'new');
  await compare(['list-a', 'cat-a'], ['topics/cat-b', 'independent']);
  assert.ok(!(await output())['topics/cat-a/index.html']);
});

test('custom templates, aliases and media invalidate only their actual consumers', async t => {
  const value = publication();
  const blockPage = (id, blocks) => ({ ...page(id), content_mode: 'blocks', blocks });
  const image = (src) => ({ id: 'picture', type: 'core/image', data: { src } });
  value.blockTypes = [
    { id: 'custom-card', container: false, schema: [], template: '<article><h2>{{item.title}}</h2>{{{item.html_content}}}</article>' },
    { id: 'custom-list', container: 'repeater', schema: [], template: '{{items}}' },
    { id: 'custom-alias', container: false, schema: [], expand_to: { target: 'core/repeater', defaults: { source_type: 'pages', content_type: 'page', filter_field: 'category', filter_value: 'a', item_block: 'custom-card' } } },
    { id: 'custom-title', container: false, schema: [], template: '<span>{{page.title}}</span>' },
    { id: 'custom-navigation', container: false, schema: [], template: '<a href="{{content_type.next.url}}">{{content_type.next.title}}</a>' },
  ];
  value.contentTypes = [{ id: 'page', fields: [{ name: 'category', type: 'text' }], route_template: '/{slug}', sort_field: 'title', sort_dir: 'asc' }];
  value.pages = [
    { ...page('a'), fields: { category: 'a' } },
    { ...page('b'), fields: { category: 'b' } },
    blockPage('alias', [{ id: 'list', type: 'custom-alias', data: {} }]),
    blockPage('list', [{ id: 'list', type: 'custom-list', data: { source_type: 'pages', content_type: 'page', filter_field: 'category', filter_value: 'a', item_block: 'custom-card' } }]),
    blockPage('photo', [image('https://media.invalid/photo.png')]),
    blockPage('photo-copy', [image('https://media.invalid/photo.png')]),
    blockPage('other-photo', [image('https://media.invalid/other.png')]),
    blockPage('missing-photo', [image('https://media.invalid/missing.png')]),
    blockPage('navigation', [{ id: 'nav', type: 'custom-navigation', data: {} }]),
    page('independent'),
  ];
  value.media = [{ id: 'photo', cdn_url: 'https://media.invalid/photo.png', width: 640, height: 400, variants: [] },
    { id: 'other', cdn_url: 'https://media.invalid/other.png', width: 500, height: 300 }];
  value.partials = [{ id: 'header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [{ id: 'title', type: 'custom-title', data: {} }] }];
  const harness = await publicationBuildHarness(value); t.after(harness.cleanup);
  await harness.run(true);
  async function compare(changed, reused) {
    await harness.run(); const receipts = await harness.receipts();
    for (const id of changed) assert.equal(receipts[`/${id}/`]?.reused, false, `${id} must render`);
    for (const id of reused) assert.equal(receipts[`/${id}/`]?.reused, true, `${id} must reuse`);
    const output = await harness.output(); await harness.run(true); assert.deepEqual(await harness.output(), output);
  }
  value.pages[0].html_content += '<p>Changed</p>';
  await compare(['a', 'alias', 'list'], ['b', 'photo', 'independent']);
  value.pages.find(page => page.id === 'other-photo').title = 'Updated neighbor';
  await compare(['navigation', 'other-photo'], ['a', 'b', 'alias', 'list', 'independent']);
  value.media[0].width = 800;
  await compare(['photo', 'photo-copy'], ['a', 'b', 'alias', 'list', 'other-photo', 'independent']);
  value.media[0].variants = [{ width: 320, format: 'avif', cdn_url: 'https://media.invalid/photo.avif' }];
  await compare(['photo', 'photo-copy'], ['other-photo', 'independent']);
  value.media.push({ id: 'missing', cdn_url: 'https://media.invalid/missing.png', width: 300, height: 200 });
  await compare(['missing-photo'], ['photo', 'other-photo', 'independent']);
  value.media.shift();
  await compare(['photo', 'photo-copy'], ['missing-photo', 'independent']);
  // Real one-page + one-image replacement, with unrelated custom block types installed.
  value.pages.find(page => page.id === 'photo').blocks[0].data.src = 'https://media.invalid/replacement.png';
  value.media.push({ id: 'replacement', cdn_url: 'https://media.invalid/replacement.png', width: 1000, height: 500 });
  await compare(['photo'], ['photo-copy', 'other-photo', 'alias', 'list', 'independent']);
  // Shared custom repeater reads must be captured on every route, even when the
  // same partial was already rendered for an earlier route or the 404 page.
  value.partials.push({ id: 'footer', kind: 'footer', status: 'published', content_mode: 'blocks', blocks: [{ id: 'footer-list', type: 'custom-alias', data: {} }] });
  await harness.run(true);
  value.pages[0].title = 'Updated A';
  await compare(['a', 'b', 'photo', 'independent'], []);
});

test('a deferred-media build has exactly the same complete output as materializing every image', async t => {
  const value = publication();
  value.media = [{ id: 'photo', cdn_url: 'https://example.invalid/photo.png', width: 640, height: 480, variants: [] }];
  value.pages[0].html_content += '<img src="https://example.invalid/photo.png" alt="Synthetic photo" />';
  const harness = await publicationBuildHarness(value); t.after(harness.cleanup);
  await fs.mkdir(path.join(harness.destination, '.publication-media'));
  const directory = await fs.realpath(path.join(harness.destination, '.publication-media'));
  const bytes = Buffer.from('synthetic media content');
  const source = path.join(directory, 'photo.png'); await fs.writeFile(source, bytes);
  const preparedPath = path.join(directory, 'prepared.json');
  const prepared = { publication_id: value.publication_id, media: value.media, files: [{ path: '/photo.png', source }] };
  await fs.writeFile(preparedPath, JSON.stringify(prepared));
  await harness.run(true, { TYPEROLL_BUILD_MEDIA_PREPARED: preparedPath });
  const complete = await harness.output(); assert.equal(complete['photo.png'], digest(bytes));
  prepared.files = [{ path: '/photo.png', reused: true, sha256: digest(bytes), size: bytes.length }];
  await fs.writeFile(preparedPath, JSON.stringify(prepared)); await fs.rm(source);
  const result = await harness.run(false, { TYPEROLL_BUILD_MEDIA_PREPARED: preparedPath });
  assert.equal(result.report.reused, 2);
  const deferred = await harness.output(); assert.equal(deferred['photo.png'], undefined);
  // The complete manifest restores the already hosted bytes, not a local placeholder.
  assert.deepEqual({ ...deferred, 'photo.png': prepared.files[0].sha256 }, complete);
});
