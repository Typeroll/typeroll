import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { prepareMedia } from './media.mjs';

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
const publication = JSON.parse(await fs.readFile(path.join(root, 'publication.json'), 'utf8'));
if (publication.format !== 'typeroll-static-publication' || publication.format_version !== 1) throw new Error('Unsupported publication format');
const sameHostMedia = await prepareMedia(publication, root);
const versionId = publication.version_id ?? 'main';
if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(versionId)) throw new Error('Invalid frozen publication version');
const work = path.join(root, '.publication-work');
await fs.rm(work, { recursive: true, force: true });
const fixtures = path.join(work, 'fixtures');
const base = 'organizations/default/sites/default';
async function writeDoc(relative, doc) {
  const { id, ...data } = doc;
  const destination = path.join(fixtures, `${relative}.json`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(data));
}
await writeDoc(base, publication.site);
await writeDoc(`${base}/versions/${versionId}`, { kind: versionId === 'main' ? 'main' : 'branch', robots_blocked: publication.settings.sitewide_noindex });
await writeDoc(`${base}/versions/${versionId}/settings/default`, publication.settings);
await writeDoc(`${base}/apps/default`, publication.apps ?? { apps: {} });
await writeDoc(`${base}/extension_runtime/default`, publication.extensions ?? { installations: [] });
for (const form of publication.forms ?? []) await writeDoc(`${base}/forms/${form.id}`, form);
for (const { definition, items } of publication.collections ?? []) {
  await writeDoc(`${base}/versions/${versionId}/collections/${definition.name}`, definition);
  for (const item of items) await writeDoc(`${base}/versions/${versionId}/collections/${definition.name}/items/${item.id}`, item);
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
await build({ entryPoints: [path.join(root, 'scripts/postprocess.ts')], outfile: path.join(work, 'postprocess.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@typeroll/shared': path.join(root, 'packages/shared/src/index.ts') } });
const { postprocess } = await import(path.join(work, 'postprocess.mjs'));
await postprocess(dist, publication);
for (const file of sameHostMedia) {
  const destination = path.resolve(dist, file.path.slice(1));
  if (!destination.startsWith(dist + path.sep)) throw new Error('Invalid public media path');
  try { await fs.access(destination); throw new Error('Media path collides with a generated page or asset'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(file.source, destination);
}
console.log(`Published ${publication.pages.length} content pages to dist/`);
