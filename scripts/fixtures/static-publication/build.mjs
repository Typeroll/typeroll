import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { validatePublicationDirectory } from '../packages/site-template/src/lib/publication-validation.mjs';
import { prepareMedia } from './media.mjs';
import { readPublicationContent } from './content.mjs';
import { resolvePublicationReferences } from './references.mjs';
import { createRenderPlan, readRenderCache, MAX_RENDER_CACHE_BYTES, RENDER_CACHE_FORMAT } from '../packages/site-template/src/lib/publication-render-cache.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'publication-manifest.json'), 'utf8'));
if (manifest.format_version !== 1) throw new Error('Unsupported publication manifest');
for (const [relative, expected] of Object.entries(manifest.files)) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root) || relative.split('/').some((part) => part === '..' || part === '.' || !part) || relative.includes('\\')) throw new Error('Invalid manifest path');
  if (!(await fs.lstat(target)).isFile()) throw new Error('Publication source must be a regular file');
  const hash = createHash('sha256').update(await fs.readFile(target)).digest('hex');
  if (hash !== expected) throw new Error(`Publication file differs from its frozen manifest: ${relative}`);
}
const frozenPublication = await readPublicationContent(JSON.parse(await fs.readFile(path.join(root, 'publication.json'), 'utf8')), name => fs.readFile(path.join(root, name), 'utf8'), manifest);
const configurationHash = createHash('sha256').update(JSON.stringify({ settings: frozenPublication.settings, contentTypes: frozenPublication.contentTypes })).digest('hex');
const publication = resolvePublicationReferences(frozenPublication);
if (publication.format !== 'typeroll-static-publication' || publication.format_version !== 2) throw new Error('Unsupported publication format');
let sameHostMedia;
if (process.env.TYPEROLL_BUILD_MEDIA_PREPARED) {
  const preparedPath = path.resolve(process.env.TYPEROLL_BUILD_MEDIA_PREPARED);
  if (!preparedPath.startsWith(root) || !(await fs.lstat(preparedPath)).isFile()) throw new Error('Invalid prepared media path');
  const prepared = JSON.parse(await fs.readFile(preparedPath, 'utf8'));
  if (prepared.publication_id !== publication.publication_id || !Array.isArray(prepared.media) || !Array.isArray(prepared.files)) throw new Error('Prepared media belongs to another publication');
  for (const file of prepared.files) if (!file.reused && !path.resolve(file.source).startsWith(path.join(root, '.publication-media') + path.sep)) throw new Error('Prepared media escaped its publication');
  publication.media = prepared.media;
  sameHostMedia = prepared.files;
} else sameHostMedia = await prepareMedia(publication, root);
const versionId = publication.version_id ?? 'main';
if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(versionId)) throw new Error('Invalid frozen publication version');
const work = path.join(root, '.publication-work');
await fs.rm(work, { recursive: true, force: true });
const cacheFile = path.join(root, '.publication-cache.json');
let previousCache = null;
if (process.env.TYPEROLL_FULL_BUILD !== '1') {
  try {
    const stat = await fs.lstat(cacheFile);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_RENDER_CACHE_BYTES)
      previousCache = readRenderCache(await fs.readFile(cacheFile));
  } catch { /* The cache is optional; an unavailable baseline means a full build. */ }
}
const cacheWork = path.join(work, 'render-cache');
await fs.mkdir(cacheWork, { recursive: true });
await fs.writeFile(path.join(cacheWork, 'input.json'), JSON.stringify({
  plan: createRenderPlan(publication, manifest), cache: previousCache,
}));
const fixtures = path.join(work, 'fixtures');
const base = 'organizations/default/sites/default';
async function writeDoc(relative, doc) {
  const { id, ...data } = doc;
  const destination = path.join(fixtures, `${relative}.json`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(data));
}
await writeDoc(base, publication.site);
await writeDoc(`${base}/versions/${versionId}`, { kind: versionId === 'main' ? 'main' : 'branch', robots_blocked: publication.robots_blocked === true });
await writeDoc(`${base}/versions/${versionId}/settings/default`, publication.settings);
await writeDoc(`${base}/apps/default`, publication.apps ?? { apps: {} });
await writeDoc(`${base}/extension_runtime/default`, publication.extensions ?? { installations: [] });
for (const form of publication.forms ?? []) await writeDoc(`${base}/forms/${form.id}`, form);
for (const type of publication.contentTypes) {
  await writeDoc(`${base}/versions/${versionId}/content_types/${type.id}`, type);
}
for (const [kind, records] of Object.entries({ pages: publication.pages, partials: publication.partials, media: publication.media, block_types: publication.blockTypes ?? [], page_templates: publication.pageTemplates ?? [] })) {
  for (const doc of records) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(doc.id)) throw new Error('Invalid publication document ID');
    await writeDoc(`${base}/${kind === 'media' ? '' : `versions/${versionId}/`}${kind}/${doc.id}`, doc);
  }
}
const env = {
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  ASTRO_TELEMETRY_DISABLED: '1', TYPEROLL_ORG_ID: 'default', TYPEROLL_SITE_ID: 'default',
  TYPEROLL_VERSION_ID: versionId, TYPEROLL_FIXTURES_DIR: fixtures, TYPEROLL_SITE_URL: publication.site_url,
  TYPEROLL_RENDER_CACHE_WORK: cacheWork,
};
const dist = path.join(root, 'dist');
await fs.rm(dist, { recursive: true, force: true });
// Invoke the pinned CLI with the current Node binary, bypassing host npm/asdf shims.
const require = createRequire(path.join(root, 'packages/site-template/package.json'));
const astroPackagePath = require.resolve('astro/package.json');
const astroPackage = JSON.parse(await fs.readFile(astroPackagePath, 'utf8'));
const astroCli = path.resolve(path.dirname(astroPackagePath), astroPackage.bin.astro);
const result = spawnSync(process.execPath, [astroCli, 'build', '--outDir', dist], {
  cwd: path.join(root, 'packages/site-template'), env, stdio: 'inherit', timeout: 10 * 60 * 1000,
});
if (result.error || result.status !== 0) throw new Error('Static renderer build failed');
// Capture raw HTML before bundling/search/extension postprocessing. Every run
// rebuilds the complete route inventory and global output from this complete tree.
let cacheRoutes = Object.create(null);
const currentRoutes = new Set();
let rendered = 0, reused = 0, cacheBytes = 0, cacheOverflow = false;
for (const name of await fs.readdir(cacheWork)) {
  if (name === 'input.json') continue;
  const { pathname, reused: hit, reason, ...entry } = JSON.parse(await fs.readFile(path.join(cacheWork, name), 'utf8'));
  currentRoutes.add(pathname);
  if (hit) {
    // Only the freshly discovered inventory emits reuse receipts. Never copy
    // removed routes or trust a cached filesystem path.
    const decoded = decodeURIComponent(pathname);
    if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..') || /[\x00-\x1f]/.test(decoded)) throw new Error('Invalid cached route path');
    const destination = path.resolve(dist, '.' + decoded, 'index.html');
    if (!destination.startsWith(dist + path.sep)) throw new Error('Cached route escaped output');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, entry.html);
  }
  cacheBytes += Buffer.byteLength(JSON.stringify(entry)) + Buffer.byteLength(JSON.stringify(pathname)) + 2;
  if (cacheBytes > MAX_RENDER_CACHE_BYTES - 1024) { cacheOverflow = true; cacheRoutes = Object.create(null); }
  if (!cacheOverflow) cacheRoutes[pathname] = entry;
  if (hit) reused++; else rendered++;
}
const report = { format: 1, mode: reused ? 'partial' : 'full', rendered, reused, total: rendered + reused,
  removed: Object.keys(previousCache?.routes ?? {}).filter(name => !currentRoutes.has(name)).length,
  reason: process.env.TYPEROLL_FULL_BUILD === '1' ? 'forced_full' : !previousCache ? 'no_valid_cache' : reused ? 'unchanged_routes_reused' : 'dependencies_changed' };
await build({ entryPoints: [path.join(root, 'scripts/postprocess.ts')], outfile: path.join(work, 'postprocess.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@typeroll/shared': path.join(root, 'packages/shared/src/index.ts') } });
const { postprocess } = await import(path.join(work, 'postprocess.mjs'));
await postprocess(dist, publication);
for (const file of new Map(sameHostMedia.map(file => [file.path, file])).values()) {
  const destination = path.resolve(dist, file.path.slice(1));
  if (!destination.startsWith(dist + path.sep)) throw new Error('Invalid public media path');
  try { await fs.access(destination); throw new Error('Media path collides with a generated page or asset'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // The trusted uploader merges only these current, verified media paths.
  if (file.reused) continue;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(file.source, destination);
}
const validation = await validatePublicationDirectory(dist, {
  publication, configurationHash, routes: JSON.parse(await fs.readFile(path.join(work, 'routes.json'), 'utf8')),
  sourceHash: createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'),
  reusedFiles: Object.fromEntries(sameHostMedia.filter(file => file.reused).map(file => [file.path.slice(1), { sha256: file.sha256, size: file.size }])),
});
await fs.writeFile(path.join(work, 'seo-report.json'), JSON.stringify(validation));
console.log('TYPEROLL_SEO_RESULT ' + JSON.stringify({ passed: validation.passed, errors: validation.error_count, warnings: validation.warning_count }));
if (!validation.passed) { console.error(JSON.stringify(validation.errors.slice(0, 10))); throw new Error('publication_validation_failed'); }
// Commit cache only after the complete output succeeds; it never enters dist or Git.
const nextCache = JSON.stringify({ format: RENDER_CACHE_FORMAT, routes: cacheRoutes });
try {
  if (!cacheOverflow && Buffer.byteLength(nextCache) <= MAX_RENDER_CACHE_BYTES) {
    await fs.writeFile(cacheFile + '.tmp', nextCache);
    await fs.rename(cacheFile + '.tmp', cacheFile);
  } else await fs.rm(cacheFile, { force: true });
} catch { /* Cache storage cannot fail a successful static publication. */ }
await fs.writeFile(path.join(work, 'render-report.json'), JSON.stringify(report));
console.log('TYPEROLL_RENDER_RESULT ' + JSON.stringify(report));
console.log(`Published ${publication.pages.length} content pages to dist/`);
