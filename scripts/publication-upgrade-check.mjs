#!/usr/bin/env node
// Publish a site prepared by an earlier release with this source.
//
// Media preparation leaves durable state in the customer's R2 bucket:
// variants, per-variant receipts and completion receipts. A release that
// cannot read what an earlier one wrote fails every publication of every site
// with published images, and no test that prepares and reads its own state
// notices. Core 0.2.72 did exactly that: the sharp 0.35.4 -> 0.35.5 update
// changed the encoder recorded in each receipt and reuse required it to match.
//
// For each recent release this prepares and publishes a small media library
// with that release's media code and its own locked sharp and S3 client, then
// publishes the same library with this source. The upgrade must succeed,
// publish byte-identical files and, under the same recipe version, write no
// variant again.
//
//   node scripts/publication-upgrade-check.mjs [--from core-v0.2.71 ...] [--count 3]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildDiagnostic } from '../packages/portal/src/lib/builds/diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = 'scripts/fixtures/static-publication';
const RUNTIME_PACKAGES = ['sharp', '@aws-sdk/client-s3'];

const parse = version => version.split('.').map(Number);
const compare = (a, b) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** The newest `count` Core releases older than `current` among `tags`. */
export function previousReleases(tags, current, count = 3) {
  return tags.map(tag => tag.match(/^core-v(\d+\.\d+\.\d+)$/)?.[1]).filter(Boolean)
    .filter(version => compare(version, current) < 0).sort(compare).reverse().slice(0, count).map(version => `core-v${version}`);
}

/** Whether the upgrade from a previous release kept everything it had published. */
export function upgradeProblems(previous, current) {
  const problems = [];
  for (const [file, digest] of Object.entries(previous.files)) {
    if (!(file in current.files)) problems.push(`${file} is no longer published`);
    else if (current.files[file] !== digest) problems.push(`${file} changed bytes (${digest.slice(0, 12)} -> ${current.files[file].slice(0, 12)})`);
  }
  if (previous.recipe_version === current.recipe_version) {
    const rewritten = current.writes.filter(key => !/\.prepared-[^/]+\.json$/.test(key));
    if (rewritten.length) problems.push(`prepared media was written again under the same recipe version: ${rewritten.slice(0, 5).join(', ')}${rewritten.length > 5 ? ', …' : ''}`);
  }
  return problems;
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const installed = name => JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(require('path').join(${JSON.stringify(path.join(root, 'node_modules'))}, ${JSON.stringify(name)}, 'package.json'), 'utf8'))`], { encoding: 'utf8' })).version;

function lockedVersions(tag) {
  const packages = JSON.parse(git('show', `${tag}:package-lock.json`)).packages;
  return Object.fromEntries(RUNTIME_PACKAGES.map(name => [name, packages[`node_modules/${name}`]?.version]));
}

/** A directory whose node_modules holds exactly these versions; the repository's own when they match. */
async function dependencies(versions, cache) {
  if (RUNTIME_PACKAGES.every(name => installed(name) === versions[name])) return path.join(root, 'node_modules');
  const dir = path.join(cache, createHash('sha256').update(JSON.stringify(versions)).digest('hex').slice(0, 16));
  try { await fs.access(path.join(dir, 'node_modules', '.complete')); return path.join(dir, 'node_modules'); } catch { /* Install below. */ }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: versions }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--omit=dev'], { cwd: dir, stdio: 'inherit' });
  if (result.status !== 0) throw Error(`Could not install ${JSON.stringify(versions)} for the upgrade check`);
  await fs.writeFile(path.join(dir, 'node_modules', '.complete'), '');
  return path.join(dir, 'node_modules');
}

/** The release's media modules, next to a node_modules with its locked runtime packages. */
async function releaseTree(tag, modules, temp) {
  const dir = path.join(temp, tag);
  for (const name of git('ls-tree', '--name-only', `${tag}:${MEDIA_DIR}`).split('\n').filter(name => name.endsWith('.mjs'))) {
    await fs.mkdir(path.join(dir, MEDIA_DIR), { recursive: true });
    await fs.writeFile(path.join(dir, MEDIA_DIR, name), git('show', `${tag}:${MEDIA_DIR}/${name}`));
  }
  await fs.symlink(modules, path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Three images (one below the smallest variant width) and one document, as originals in the store. */
async function createStore(dir) {
  const sharp = (await import('sharp')).default;
  const account = 'a'.repeat(32), prefix = 'media/upgradecheck';
  const images = [
    ['hero.jpg', 'image/jpeg', await sharp({ create: { width: 2100, height: 1400, channels: 3, background: '#1374aa' } }).jpeg().toBuffer()],
    ['logo.png', 'image/png', await sharp({ create: { width: 640, height: 480, channels: 4, background: '#ffffff00' } }).png().toBuffer()],
    ['icon.webp', 'image/webp', await sharp({ create: { width: 240, height: 160, channels: 3, background: '#aa3713' } }).webp().toBuffer()],
    ['guide.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n% upgrade check\n')],
  ];
  await fs.mkdir(path.join(dir, 'objects'), { recursive: true });
  const entries = [];
  for (const [name, mime, bytes] of images) {
    const source = `private/${prefix}/originals/${name}`, sha256 = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(dir, 'objects', encodeURIComponent(source)), bytes);
    entries.push({ id: name, source_key: source, public_key: `${prefix}/${name}`, public_path: `/media/${name}`, mime_type: mime,
      cdn_url: `https://www.example.com/media/${name}`, sha256, size_bytes: bytes.length, aliases: [{ key: `${prefix}/shared/${name}`, url: `https://www.example.com/shared/${name}` }] });
  }
  await fs.writeFile(path.join(dir, 'fixture.json'), JSON.stringify({ account, prefix, entries }));
}

function runRelease(releaseDir, store, work) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/lib/publication-upgrade-runner.mjs'), releaseDir, store, work], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    const { cause, lines } = buildDiagnostic(result.stderr || result.stdout);
    return { error: [cause ?? `exit code ${result.status}`, ...lines.filter(line => line.trim() !== cause).slice(-8)].join('\n') };
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

export async function checkUpgrade(tag, { temp, cache }) {
  const versions = lockedVersions(tag);
  if (RUNTIME_PACKAGES.some(name => !versions[name])) return { tag, skipped: 'the release has no locked media runtime' };
  try { git('cat-file', '-e', `${tag}:${MEDIA_DIR}/media.mjs`); } catch { return { tag, skipped: 'the release has no media preparation' }; }
  const store = path.join(temp, `${tag}-store`);
  await createStore(store);
  const previous = runRelease(await releaseTree(tag, await dependencies(versions, cache), temp), store, path.join(temp, `${tag}-previous`));
  // Not this source's fault, but a check that cannot run must not pass.
  if (previous.error) return { tag, versions, problems: [`the release itself could not prepare the fixture, so the upgrade was not checked:\n${previous.error}`] };
  const current = runRelease(root, store, path.join(temp, `${tag}-current`));
  if (current.error) return { tag, versions, problems: [`publishing failed:\n${current.error}`] };
  // Earlier releases may not have written completion receipts; check per-variant receipts on their own too.
  for (const name of await fs.readdir(path.join(store, 'objects'))) if (/\.prepared-[^/]+\.json$/.test(decodeURIComponent(name))) await fs.rm(path.join(store, 'objects', name));
  const variants = runRelease(root, store, path.join(temp, `${tag}-variants`));
  if (variants.error) return { tag, versions, problems: [`publishing from per-variant receipts failed:\n${variants.error}`] };
  return { tag, versions, problems: [...upgradeProblems(previous, current), ...upgradeProblems(previous, variants)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { from: { type: 'string', multiple: true }, count: { type: 'string', default: '3' } } });
  const current = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const tags = values.from ?? previousReleases(git('tag', '--list', 'core-v*', '--merged', 'HEAD').split('\n'), current, Number(values.count));
  if (!tags.length) { console.error('No earlier Core release is reachable from HEAD. Fetch tags (git fetch --tags) and retry.'); process.exit(1); }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'typeroll-upgrade-'));
  const cache = path.join(os.tmpdir(), 'typeroll-upgrade-dependencies');
  let failed = false;
  try {
    console.log(`Publishing media prepared by earlier releases with ${current} (sharp ${installed('sharp')}).`);
    for (const tag of tags) {
      const result = await checkUpgrade(tag, { temp, cache });
      const from = result.versions ? ` (sharp ${result.versions.sharp})` : '';
      if (result.skipped) console.log(`- ${tag}${from}: skipped, ${result.skipped}`);
      else if (!result.problems.length) console.log(`- ${tag}${from}: ok`);
      else { failed = true; console.error(`- ${tag}${from}: FAILED\n${result.problems.map(problem => `    ${problem.replaceAll('\n', '\n    ')}`).join('\n')}`); }
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  if (failed) { console.error('\nA site prepared by an earlier release cannot be published with this source. Keep reading what earlier releases wrote, or version the change so it is prepared again.'); process.exit(1); }
}
