import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationContentFiles, readPublicationContent, stableJson } from './fixtures/static-publication/content.mjs';
import { digest } from './lib/customer-publishing.mjs';

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
