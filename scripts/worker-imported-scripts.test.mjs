import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The portal Worker bundles some modules from scripts/ (publication
// projections). A bundled Worker has no file URL, so a module that resolves a
// path from import.meta.url while it loads fails every request that imports
// it. Load each one the way the Worker does: bundled, from a non-file URL.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTAL_SRC = path.join(ROOT, 'packages/portal/src');

function workerImportedScripts() {
  const found = new Set();
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const file = path.join(directory, entry);
      if (entry === '__tests__') continue;
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(ts|tsx|astro|mjs)$/.test(entry)) {
        for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/from '((?:\.\.\/)+scripts\/[^'?]+\.mjs)'/g)) {
          const resolved = path.resolve(path.dirname(file), specifier);
          if (resolved.startsWith(path.join(ROOT, 'scripts') + path.sep)) found.add(resolved);
        }
      }
    }
  };
  walk(PORTAL_SRC);
  return [...found].sort();
}

test('scripts modules the portal Worker imports load without a file URL', async () => {
  const modules = workerImportedScripts();
  assert.ok(modules.some(file => file.endsWith('scripts/lib/static-publication.mjs')), 'the publication projection is found');
  for (const entry of modules) {
    const { outputFiles } = await build({
      entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'error',
    });
    const source = outputFiles[0].text;
    await assert.doesNotReject(
      import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`),
      `${path.relative(ROOT, entry)} must not resolve files while it loads`,
    );
  }
});
