import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeMediaPreparation, mediaPreparationScope } from './fixtures/static-publication/media-preparation.mjs';

const fixture = () => ({ media_manifest: { account_id: 'account', original_bucket: 'private', public_bucket: 'public', site_prefix: 'site', entries: [
  { source_key: 'original/image', public_key: 'media/image', public_path: '/media/image', sha256: 'a'.repeat(64), mime_type: 'image/jpeg', size_bytes: 123, aliases: [{ key: 'old/image', url: 'https://media.example.test/old/image' }] },
] } });
test('a verified unchanged library skips preparation independently of page content', () => {
  const previous = fixture(); previous.media_preparation_scope = freezeMediaPreparation(previous, null);
  const next = { ...fixture(), pages: [{ title: 'Changed text' }] };
  assert.equal(freezeMediaPreparation(next, previous, true).cursor, 1);
  assert.equal(freezeMediaPreparation(next, previous, true).reused, true);
  assert.equal(freezeMediaPreparation(next, previous, false).cursor, 0);
});
test('source bytes, aliases, bucket moves, recipe changes and removed retained media invalidate reuse', () => {
  const previous = fixture(); previous.media_preparation_scope = mediaPreparationScope(previous);
  for (const mutate of [p => { p.media_manifest.entries[0].sha256 = 'b'.repeat(64); }, p => { p.media_manifest.entries[0].aliases[0].url = 'https://other.test/image'; },
    p => { p.media_manifest.public_bucket = 'different'; }, p => { p.retained_media_manifests = [fixture().media_manifest]; }]) {
    const next = fixture(); mutate(next); assert.equal(freezeMediaPreparation(next, previous, true).cursor, 0);
  }
  previous.media_preparation_scope.recipe = 'old-recipe';
  assert.equal(freezeMediaPreparation(fixture(), previous, true).cursor, 0);
  assert.equal(freezeMediaPreparation(fixture(), fixture(), true).cursor, 0);
});

test('deleting media preserves preparation for every remaining exact receipt', () => {
  const previous = fixture();
  const second = structuredClone(previous.media_manifest.entries[0]); second.public_key = 'media/second'; second.public_path = '/media/second';
  previous.media_manifest.entries.push(second);
  previous.media_preparation_scope = mediaPreparationScope(previous);
  const next = fixture();
  assert.equal(freezeMediaPreparation(next, previous, true).cursor, 1);
  assert.equal(freezeMediaPreparation(next, previous, true).reused, true);
  const missingProof = structuredClone(previous); missingProof.media_preparation_scope.scope = 'invalid';
  assert.equal(freezeMediaPreparation(next, missingProof, true).reused, false);
  next.media_manifest.entries[0].aliases[0].key = 'new/alias';
  assert.equal(freezeMediaPreparation(next, previous, true).reused, false);
});
