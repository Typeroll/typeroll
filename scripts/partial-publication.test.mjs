import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStaticPublicationProject, sealPublicationProject } from './lib/static-publication.mjs';
import { publicationContentFiles } from './fixtures/static-publication/content.mjs';
import { createRenderPlan, routeFingerprint, validCacheEntry, readRenderCache, digest } from '../packages/site-template/src/lib/publication-render-cache.mjs';

const page = (id, body = id) => ({ id, slug: id, title: id, status: 'published', content_mode: 'html', html_content: `<h1>${id}</h1><p>${body}</p>` });
const publication = () => ({ format: 'typeroll-static-publication', format_version: 2, publication_id: 'a'.repeat(64),
  core_commit: 'a'.repeat(40), site_url: 'https://example.invalid', version_id: 'main', site: { name: 'Test' },
  settings: { site_name: 'Test', trailing_slash: 'always' }, pages: [page('one'), page('two')],
  media: [], partials: [], contentTypes: [], pageTemplates: [], blockTypes: [], forms: [] });
const manifest = { files: { 'packages/shared/src/index.ts': 'code', 'publication.json': 'source', 'content/pages/one.json': 'body' } };

test('body edits are local; query consumers, navigation metadata and global changes invalidate safely', () => {
  const value = publication();
  value.pages.push({ ...page('list'), content_mode: 'blocks', blocks: [{ id: 'listing', type: 'core/page_list', data: { content_type: 'page' } }] });
  const baseline = createRenderPlan(value, manifest);
  value.pages[0].html_content += '<p>New body</p>'; value.pages[0].date_updated = '2026-09-18';
  const next = createRenderPlan(value, manifest);
  assert.notEqual(next.keys.one.key, baseline.keys.one.key);
  assert.equal(next.keys.two.key, baseline.keys.two.key);
  assert.notEqual(next.keys.list.key, baseline.keys.list.key);
  for (const mutate of [
    v => { v.pages[0].title = 'Renamed'; }, v => { v.pages[0].slug = 'new'; },
    v => { v.pages[0].status = 'draft'; }, v => { v.pages.pop(); }, v => { v.pages.push(page('new')); },
    v => { v.settings.sitewide_noindex = true; }, v => { v.site_url = 'https://new.invalid'; },
    v => { v.version_id = 'redesign'; }, v => { v.media.push({ id: 'new', cdn_url: 'https://media.invalid/new' }); },
    v => { v.pageTemplates.push({ id: 'template', blocks: [] }); },
    v => { v.pages[0].fields = { category: 'new' }; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.notEqual(createRenderPlan(changed, manifest).keys.two.key, next.keys.two.key);
  }
  assert.notEqual(createRenderPlan(value, { files: { ...manifest.files, 'package-lock.json': 'new' } }).keys.two.key, next.keys.two.key);
  assert.notEqual(createRenderPlan(value, manifest, 'new-runtime').keys.two.key, next.keys.two.key);
  assert.equal(createRenderPlan({ ...value, publication_id: 'b'.repeat(64), published_at: 'later' }, manifest).keys.two.key, next.keys.two.key);
  assert.equal(createRenderPlan({ ...value, source_impact_snapshot: { changed: 'diagnostic' }, media_manifest: { publication_id: 'new' } }, manifest).keys.two.key, next.keys.two.key);
});

test('custom blocks, reference lists, templates and timestamp sorting widen body dependencies', () => {
  for (const mutate of [
    v => { v.pages[1].blocks = [{ type: 'custom/unknown' }]; },
    v => { v.pages[1].blocks = [{ type: 'core/field_list' }]; },
    v => { v.pages[1].template = 'tpl'; v.pageTemplates = [{ id: 'tpl', blocks: [{ type: 'core/repeater' }] }]; },
    v => { v.partials = [{ blocks: [{ type: 'core/page_list' }] }]; },
    v => { v.blockTypes = [{ id: 'core/heading' }]; },
    v => { v.contentTypes = [{ id: 'page', sort_field: 'date_updated' }]; },
    v => { v.contentTypes = [{ id: 'page', sort_field: 'body' }]; },
    v => { v.contentTypes = [{ id: 'page', route_template: '/notes/{html_content}' }]; },
    v => { v.contentTypes = [{ id: 'page', template: 'tpl' }]; v.pageTemplates = [{ id: 'tpl', blocks: [{ type: 'core/repeater' }] }]; },
  ]) {
    const value = publication(); mutate(value);
    const before = createRenderPlan(value, manifest);
    value.pages[0].html_content += 'changed'; value.pages[0].date_updated = 'later';
    assert.notEqual(createRenderPlan(value, manifest).keys.two.key, before.keys.two.key);
  }
});

test('route identity, pagination and cache integrity are required for reuse', () => {
  const value = publication(), plan = createRenderPlan(value, manifest), props = { page: value.pages[0] };
  const key = routeFingerprint(plan, '/one/', props);
  const entry = { fingerprint: key, html: '<h1>One</h1>', sha256: digest('<h1>One</h1>') };
  assert.ok(validCacheEntry(entry, key));
  assert.ok(!validCacheEntry({ ...entry, html: 'corrupted' }, key));
  assert.ok(!validCacheEntry(entry, routeFingerprint(plan, '/two/', props)));
  assert.ok(!validCacheEntry(entry, routeFingerprint(plan, '/one/', { ...props, pageNum: 2 })));
  const facetProps = { page: value.pages[1], facet: { filters: [{ field: 'category', value: 'test' }] } };
  const facetKey = routeFingerprint(plan, '/category/test/', facetProps);
  value.pages[0].html_content += 'changed';
  assert.notEqual(routeFingerprint(createRenderPlan(value, manifest), '/category/test/', facetProps), facetKey);
  assert.equal(readRenderCache(Buffer.from('{broken')), null);
  assert.equal(readRenderCache(Buffer.from('{"format":2,"routes":{}}')), null);
});

test('partial output equals a clean full build after edits, deletion, noindex and origin changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-partial-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'site');
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
  await createStaticPublicationProject(value, destination);
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  async function run(full = false) {
    for (const [name, content] of Object.entries(publicationContentFiles(value))) {
      await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true });
      await fs.writeFile(path.join(destination, name), content);
    }
    await sealPublicationProject(destination);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination,
      env: { PATH: process.env.PATH, ...(full ? { TYPEROLL_FULL_BUILD: '1' } : {}) }, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(await fs.readFile(path.join(destination, '.publication-work/render-report.json'), 'utf8'));
  }
  async function output() {
    const files = {};
    async function walk(dir, prefix = '') {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), prefix + entry.name + '/');
        else files[prefix + entry.name] = digest(await fs.readFile(path.join(dir, entry.name)));
      }
    }
    await walk(path.join(destination, 'dist')); return files;
  }
  assert.deepEqual(await run(), { format: 1, mode: 'full', rendered: 52, reused: 0, total: 52, removed: 0, reason: 'no_valid_cache' });
  value.pages[0].blocks[0].data.html += '<p>Changed body</p>'; value.pages[0].date_updated = '2026-09-18';
  value.publication_id = 'b'.repeat(64);
  const partial = await run();
  assert.equal(partial.reused, 49); assert.equal(partial.rendered, 3);
  const partialFiles = await output();
  await run(true); assert.deepEqual(await output(), partialFiles);
  assert.equal((await run()).reused, 52);
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
