import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationContentFiles, readPublicationContent } from './fixtures/static-publication/content.mjs';
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
