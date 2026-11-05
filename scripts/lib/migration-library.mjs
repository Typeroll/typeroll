// Loads the portal's TypeScript migration library for a plain Node script.
//
// Node's type stripping cannot run the portal sources (extensionless imports,
// Vite `?raw` imports, workspace packages exporting TypeScript), so the entry
// point is bundled with the repository's esbuild into the portal's
// node_modules cache. npm packages stay external and resolve from there.
// Each process bundles into its own directory, so parallel callers (the
// migrate-store and self-host backup tests) never delete each other's output.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'packages/portal/src/lib/migration/index.ts');
const CACHE = path.join(ROOT, 'packages/portal/node_modules/.cache/typeroll-migrate-store');
const PROCESS_DIR = /^(\d+)-[0-9a-f]+$/;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Remove the bundles of processes that have exited (and the old shared layout). */
function removeStaleBundles() {
  if (!fs.existsSync(CACHE)) return;
  for (const entry of fs.readdirSync(CACHE)) {
    const match = PROCESS_DIR.exec(entry);
    if (match && processAlive(Number(match[1]))) continue;
    fs.rmSync(path.join(CACHE, entry), { recursive: true, force: true });
  }
}

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
  removeStaleBundles();
  const OUTDIR = path.join(CACHE, `${process.pid}-${randomBytes(4).toString('hex')}`);
  process.once('exit', () => fs.rmSync(OUTDIR, { recursive: true, force: true }));
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
