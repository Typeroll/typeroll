import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationContentFiles, readPublicationContent, stableJson } from './fixtures/static-publication/content.mjs';
import { digest } from './lib/customer-publishing.mjs';
import { createHash } from 'node:crypto';

test('record files preserve branches, remove stale content and reuse every unchanged page', async () => {
  const publication = { version_id: 'design', pages: Array.from({ length: 258 }, (_, i) => ({ id: `page-${i}`, title: `Page ${i}`, html_content: 'x'.repeat(12000) })), pageTemplates: [{ id: 'article', blocks: [] }], media_manifest: { entries: [] } };
  const files = publicationContentFiles(publication);
  const manifest = { files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, digest(text)])) };
  assert.deepEqual(await readPublicationContent(JSON.parse(files['publication.json']), async name => files[name], manifest), publication);
  const next = structuredClone(publication);
  next.pages[0].title = 'Edited'; next.pages.pop();
  const changed = publicationContentFiles(next);
  assert.deepEqual(Object.keys(changed).filter(name => changed[name] !== files[name]).sort(), ['content/pages/page-0.json', 'publication.json']);
  assert.equal(changed['content/pages/page-257.json'], undefined);
  assert.ok(Buffer.byteLength(changed['content/pages/page-0.json']) < 13000);
});

test('menus travel as their own record files', async () => {
  const publication = { version_id: 'main', pages: [{ id: 'home', title: 'Home' }], menus: [{ id: 'main', name: 'Main', locations: ['primary'], items: [{ id: 'home', type: 'page', page_id: 'home' }] }] };
  const files = publicationContentFiles(publication);
  assert.ok(files['content/menus/main.json']);
  assert.deepEqual(JSON.parse(files['publication.json']).content_files.menus, ['content/menus/main.json']);
  const manifest = { files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, digest(text)])) };
  assert.deepEqual(await readPublicationContent(JSON.parse(files['publication.json']), async name => files[name], manifest), publication);
});

test('content index rejects traversal, unverified paths, duplicate IDs and mismatched records', async () => {
  assert.throws(() => publicationContentFiles({ pages: [{ id: '../escape' }] }), /identity/);
  assert.throws(() => publicationContentFiles({ pages: [{ id: 'home' }, { id: 'home' }] }), /identity/);
  for (const name of ['../escape', 'content/pages/home.json']) {
    await assert.rejects(readPublicationContent({ content_files: { pages: [name] } }, async () => '{}', { files: {} }), /Unverified/);
  }
  await assert.rejects(readPublicationContent({ content_files: { pages: ['content/pages/home.json'] } }, async () => '{"id":"other"}', { files: { 'content/pages/home.json': 'hash' } }), /identity mismatch/);
});

test('a record edit produces a reviewable line diff, independent of key order', () => {
  const page = { id: 'home', title: 'Welcome', blocks: [{ id: 'intro', type: 'prose', data: { html: '<p>Text</p>' } }] };
  const files = publicationContentFiles({ version_id: 'main', settings: { locale: 'sv' }, pages: [page] });
  const before = files['content/pages/home.json'];
  assert.deepEqual(JSON.parse(before), page);
  assert.ok(before.split('\n').length > 5, 'a record is written over several lines');
  assert.deepEqual(Object.keys(JSON.parse(before)), ['blocks', 'id', 'title']);
  assert.deepEqual(Object.keys(JSON.parse(before).blocks[0]), ['data', 'id', 'type']);

  const edited = publicationContentFiles({ version_id: 'main', settings: { locale: 'sv' }, pages: [{ ...page, title: 'Hello' }] });
  const after = edited['content/pages/home.json'].split('\n');
  const changed = before.split('\n').map((line, index) => [line, after[index]]).filter(([line, next]) => line !== next);
  assert.deepEqual(changed, [['  "title": "Welcome"', '  "title": "Hello"']]);

  // Key order in the CMS record must not reach the repository as a diff.
  const reordered = publicationContentFiles({ settings: { locale: 'sv' }, version_id: 'main', pages: [{ blocks: page.blocks, title: page.title, id: page.id }] });
  assert.equal(reordered['content/pages/home.json'], before);
  assert.equal(reordered['publication.json'], files['publication.json']);
  assert.ok(stableJson({ b: 1, a: 2 }).endsWith('\n'));
});

test('large derived data and the impact snapshot leave publication.json in size-bounded files', async () => {
  const profiles = Array.from({ length: 900 }, (_, i) => ({ zeta: i, id: `companies_${i}`, alpha: 'x'.repeat(1500) }));
  const publication = { format: 'typeroll-static-publication', format_version: 2, pages: [], derived: { 'directory.profiles': profiles, 'directory.meta': { b: 1, a: 2 } },
    source_impact_snapshot: { pages: { a: 1 } }, media_manifest: { entries: [] }, extensions: { installations: [] } };
  const files = publicationContentFiles(publication);
  const meta = JSON.parse(files['publication.json']);
  assert.equal(meta.derived, undefined);
  assert.equal(meta.source_impact_snapshot, undefined);
  // Fields build engines read from publication.json stay in it.
  assert.deepEqual(meta.media_manifest, { entries: [] });
  const parts = meta.content_files.derived.find(entry => entry.source === 'directory.profiles').files;
  assert.ok(parts.length > 1);
  for (const name of parts) assert.ok(Buffer.byteLength(files[name]) < 700 * 1024, name);
  const manifest = { files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')])) };
  const back = await readPublicationContent(meta, async name => files[name], manifest);
  assert.deepEqual(back, publication);
  // Order is kept: the build hashes derived data into its public URL.
  assert.equal(JSON.stringify(back.derived), JSON.stringify(publication.derived));
  // An unchanged record keeps its part, so Git reuses the blob.
  const edited = publicationContentFiles({ ...publication, derived: { ...publication.derived, 'directory.profiles': profiles.map((p, i) => i === 899 ? { ...p, zeta: -1 } : p) } });
  assert.equal(edited[parts[0]], files[parts[0]]);
  assert.notEqual(edited[parts.at(-1)], files[parts.at(-1)]);
});

test('a split publication only reads indexed, verified parts', async () => {
  const files = publicationContentFiles({ pages: [], derived: { 'a.b': [1, 2] }, source_impact_snapshot: {} });
  const meta = JSON.parse(files['publication.json']);
  const manifest = { files: Object.fromEntries(Object.keys(files).map(name => [name, 'x'])) };
  await assert.rejects(readPublicationContent({ ...meta, content_files: { ...meta.content_files, derived: [{ source: 'a.b', array: true, files: ['content/derived/other/0000.json'] }] } }, async name => files[name], manifest), /Invalid publication content index/);
  await assert.rejects(readPublicationContent({ ...meta, content_files: { ...meta.content_files, metadata: { settings: 'content/metadata/settings.json' } } }, async name => files[name], manifest), /Invalid publication content index/);
  await assert.rejects(readPublicationContent(meta, async name => files[name], { files: {} }), /Unverified publication record/);
});
