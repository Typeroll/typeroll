import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retired = /\b(?:create|list|read|update|replace|delete|batch_read)_collection(?:_items?|s)?\b|\bcollection_completeness\b|\bitem_template_(?:html|blocks)\b|core\/collection_list|template\/item_(?:body|title|image|navigation)\b|\bref_collection\b|\bitem_ref(?:_list)?\b/;
function files(relative) {
  const full = path.join(root, relative);
  return fs.statSync(full).isDirectory()
    ? fs.readdirSync(full).flatMap(name => files(path.join(relative, name)))
    : [relative];
}

test('active documentation, MCP recipes and site scaffolding do not teach removed content APIs', () => {
  const candidates = [
    'README.md', 'CONTRIBUTING.md', 'docs/content-model.md', 'docs/page-compositions.md',
    'docs/v1-api.md', 'packages/portal/README.md', 'packages/shared/README.md',
    'packages/site-template/README.md', 'packages/mcp-server/README.md', 'packages/mcp-server/AGENTS.md',
    'packages/mcp-server/src/init.ts', 'packages/mcp-server/src/server.ts',
    ...files('packages/mcp-server/skills'), ...files('packages/mcp-server/templates'),
    ...files('packages/mcp-server/src/tools'), ...files('packages/docs-site/src/content/docs'),
  ].filter(file => /\.(md|mdx|ts)$/.test(file));
  const failures = candidates.filter(file => retired.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(failures, [], 'Retired content contract in active documentation');
  // Astro Content Collections, Webflow source exports and Firestore collections
  // are other systems' terminology; do not rename their technical APIs.
});

test('the shipped site fixture stores all content in Pages with known Content types', () => {
  const version = 'packages/site-template/fixtures/organizations/default/sites/default/versions/main';
  const legacy = `${version}/collections`;
  assert.deepEqual(fs.existsSync(path.join(root, legacy)) ? files(legacy) : [], [], 'No legacy content files may ship');
  const types = new Set(['page', ...files(`${version}/content_types`).map(file => path.basename(file, '.json'))]);
  const pages = files(`${version}/pages`).filter(file => file.split('/').length === version.split('/').length + 2 && file.endsWith('.json'));
  assert.ok(pages.length > 0);
  for (const file of pages) {
    const page = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.ok(types.has(page.content_type), `${file}: unknown content type`);
    assert.doesNotMatch(JSON.stringify(page), /getCollectionItemRoutes|pageForItem|collection-item build/);
  }
});
