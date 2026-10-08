import assert from 'node:assert/strict';
import test from 'node:test';
import { previousReleases, upgradeProblems } from './publication-upgrade-check.mjs';

test('checks the newest earlier Core releases, never the release being made or a later one', () => {
  const tags = ['core-v0.2.9', 'core-v0.2.71', 'core-v0.2.73', 'core-v0.2.74', 'core-v0.2.75', 'mcp-v0.45.55', 'core-v0.2.72', ''];
  assert.deepEqual(previousReleases(tags, '0.2.74'), ['core-v0.2.73', 'core-v0.2.72', 'core-v0.2.71']);
  assert.deepEqual(previousReleases(tags, '0.2.74', 1), ['core-v0.2.73']);
  assert.deepEqual(previousReleases(tags, '0.2.9'), []);
});

test('an upgrade must keep every published file byte-identical and not prepare media again', () => {
  const previous = { recipe_version: 'v2', writes: [], files: { '/media/hero.jpg': 'a'.repeat(64), '/media/hero.jpg.v2.w320.x.webp': 'b'.repeat(64) } };
  assert.deepEqual(upgradeProblems(previous, { recipe_version: 'v2', writes: ['media/hero.jpg.prepared-v2.abc.json'], files: { ...previous.files } }), []);
  const problems = upgradeProblems(previous, { recipe_version: 'v2', writes: ['media/hero.jpg.v2.w320.x.webp'], files: { '/media/hero.jpg': 'c'.repeat(64) } });
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /hero\.jpg changed bytes/);
  assert.match(problems.join('\n'), /w320\.x\.webp is no longer published/);
  assert.match(problems.join('\n'), /written again under the same recipe version/);
  // A new recipe version prepares variants under new keys; that is the intended way to change them.
  assert.deepEqual(upgradeProblems({ ...previous, files: {} }, { recipe_version: 'v3', writes: ['media/hero.jpg.v3.w320.x.webp'], files: {} }), []);
});
