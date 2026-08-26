import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cloudOnlyPaths = [
  '.github/workflows/deploy.yml',
  '.github/workflows/docs.yml',
  'packages/marketing',
  'packages/portal/src/components/BuildCosts.tsx',
  'packages/portal/src/__tests__/lib/platform-admin-access.test.ts',
  'packages/portal/src/__tests__/lib/platform-admin-discipline.test.ts',
  'packages/portal/src/__tests__/lib/platform-overview.test.ts',
  'packages/portal/src/layouts/AdminLayout.astro',
  'packages/portal/src/lib/platform',
  'packages/portal/src/pages/api/internal-admin',
  'packages/portal/src/pages/internal-admin',
  'scripts/cloudflare-fallback-noindex.mjs',
  'scripts/cloudflare-fallback-noindex.test.mjs',
];

const requiredOpenSourcePaths = [
  'packages/portal/src/lib/workflows/migration.ts',
  'packages/portal/src/pages/api/sites/create-and-migrate.ts',
  'packages/portal/src/lib/wp/helper-client.ts',
  'wp-helper-plugin/LICENSE',
  'wp-helper-plugin/typeroll-helper.php',
];

test('the public repository excludes Typeroll Cloud implementation paths', () => {
  const leaked = cloudOnlyPaths.filter((relative) => existsSync(path.join(root, relative)));
  assert.deepEqual(leaked, []);
});

test('the public workspace does not expose Cloud-only scripts', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const scripts = Object.keys(pkg.scripts ?? {});
  assert.equal(scripts.some((name) => name.includes('marketing')), false);
  assert.equal(scripts.some((name) => name.includes('fallback-noindex')), false);
});

test('the public repository includes the WordPress migration implementation', () => {
  const missing = requiredOpenSourcePaths.filter(
    (relative) => !existsSync(path.join(root, relative)),
  );
  assert.deepEqual(missing, []);

  const registry = readFileSync(
    path.join(root, 'packages/portal/src/lib/workflows/registry.ts'),
    'utf8',
  );
  assert.match(registry, /migrationWorkflow/);
  assert.match(registry, /from ['"]\.\/migration['"]/);
});
