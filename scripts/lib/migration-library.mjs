// Loads the portal's TypeScript migration library for a plain Node script.
//
// Node's type stripping cannot run the portal sources (extensionless imports,
// Vite `?raw` imports, workspace packages exporting TypeScript), so the entry
// point is bundled with the repository's esbuild into the portal's
// node_modules cache. npm packages stay external and resolve from there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'packages/portal/src/lib/migration/index.ts');
const OUTDIR = path.join(ROOT, 'packages/portal/node_modules/.cache/typeroll-migrate-store');

const sourcesPlugin = {
  name: 'typeroll-sources',
  setup(build) {
    // Vite's `?raw`: the file's text as the default export.
    build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }));
    // npm packages and runtime built-ins stay external; workspace packages are TypeScript and get bundled.
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path.startsWith('@typeroll/') || args.kind === 'entry-point') return undefined;
      return { path: args.path, external: true };
    });
  },
};

let loaded = null;

/** Bundle once per process and import the result. */
export function loadMigrationLibrary() {
  loaded ??= bundleAndImport();
  return loaded;
}

async function bundleAndImport() {
  const { build } = await import('esbuild');
  fs.rmSync(OUTDIR, { recursive: true, force: true });
  await build({
    // Splitting keeps dynamic imports (Workers-only modules such as `cloudflare:sockets`) out of the startup path.
    entryPoints: { migration: ENTRY }, outdir: OUTDIR, outExtension: { '.js': '.mjs' }, splitting: true,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    plugins: [sourcesPlugin], logLevel: 'error',
    // Bundled CommonJS helpers may still call require().
    banner: { js: "import { createRequire as __trCreateRequire } from 'node:module'; const require = __trCreateRequire(import.meta.url);" },
  });
  return import(pathToFileURL(path.join(OUTDIR, 'migration.mjs')).href);
}
