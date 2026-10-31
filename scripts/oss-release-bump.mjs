#!/usr/bin/env node

// Applies the Core and MCP version bumps that `npm run release:plan` asks for.
//
//   npm run release:bump                 bump what the plan requires (patch)
//   npm run release:bump -- --dry-run    print the bump without writing
//   npm run release:bump -- --core 0.3.0 --mcp 0.46.0   explicit targets
//
// Every version source is rewritten from its expected current value, so a
// source that drifted from package.json fails loudly instead of being skipped.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { currentPlan, currentPlanInputs, requiredVersionBumps, tagSha } from './oss-release-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const RENDER_VERSION_FILE = 'packages/shared/src/render-version.ts';
export const LOCKFILE = 'package-lock.json';

/** Every literal that carries a released version, by artifact. */
export const VERSION_SOURCES = {
  core: [
    { file: 'package.json', pattern: /^( {2}"version": ")([^"]+)(",?)$/m },
    { file: 'packages/shared/src/release.ts', pattern: /^(export const CORE_VERSION = ')([^']+)(';)$/m },
    { file: 'scripts/lib/self-host-schema.mjs', pattern: /^(export const SELF_HOST_CORE_VERSION = ')([^']+)(';)$/m },
    { file: 'scripts/oss-release-plan.test.mjs', pattern: /(assert\.equal\(manifest\.core_version, ')([^']+)('\);)/ },
  ],
  mcp: [
    { file: 'packages/mcp-server/package.json', pattern: /^( {2}"version": ")([^"]+)(",?)$/m },
    { file: 'packages/mcp-server/src/version.ts', pattern: /^(export const VERSION = ')([^']+)(';)$/m },
    { file: 'scripts/oss-release-plan.test.mjs', pattern: /(assert\.equal\(manifest\.mcp_version, ')([^']+)('\);)/ },
  ],
};

export function parseVersion(version) {
  const match = typeof version === 'string' ? version.match(STABLE_VERSION) : null;
  if (!match) throw new Error(`"${version}" is not a stable semantic version (x.y.z)`);
  return match.slice(1, 4).map(Number);
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function nextPatch(version) {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** The highest `core_version` declared by `RENDER_VERSIONS`. */
export function latestRenderCoreVersion(source) {
  const versions = [...source.matchAll(/core_version:\s*'([^']+)'/g)].map((match) => match[1]);
  if (versions.length === 0) throw new Error(`No render version core_version found in ${RENDER_VERSION_FILE}`);
  return versions.reduce((latest, version) => (compareVersions(version, latest) > 0 ? version : latest));
}

/**
 * A render version records the Core release that introduces it, so it is
 * written before the bump. The bump must land on that version; a render
 * version claiming a release later than the one being published is an error.
 */
export function coreBumpTarget({ current, renderCoreVersion, explicit }) {
  parseVersion(current);
  const renderAhead = renderCoreVersion && compareVersions(renderCoreVersion, current) > 0;
  if (explicit) {
    if (compareVersions(explicit, current) <= 0) {
      throw new Error(`--core ${explicit} must be greater than the current Core version ${current}`);
    }
    if (renderAhead && compareVersions(explicit, renderCoreVersion) !== 0) {
      throw new Error(`--core ${explicit} disagrees with ${RENDER_VERSION_FILE}, whose newest render version is introduced in Core ${renderCoreVersion}; use --core ${renderCoreVersion} or correct its core_version`);
    }
    return explicit;
  }
  return renderAhead ? renderCoreVersion : nextPatch(current);
}

export function mcpBumpTarget({ current, explicit }) {
  parseVersion(current);
  if (!explicit) return nextPatch(current);
  if (compareVersions(explicit, current) <= 0) {
    throw new Error(`--mcp ${explicit} must be greater than the current MCP version ${current}`);
  }
  return explicit;
}

/** When Core is not bumped, the version it will publish must cover every render version. */
export function assertRenderVersionReleased({ coreVersion, renderCoreVersion }) {
  if (compareVersions(renderCoreVersion, coreVersion) > 0) {
    throw new Error(`${RENDER_VERSION_FILE} declares a render version introduced in Core ${renderCoreVersion}, but this tree publishes Core ${coreVersion}; set its core_version to ${coreVersion} or run with --core ${renderCoreVersion}`);
  }
}

/** Replaces one version literal, requiring exactly one match that holds `from`. */
export function rewriteVersion(source, { file, pattern }, from, to) {
  parseVersion(to);
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = [...source.matchAll(global)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one version literal matching ${pattern} in ${file}, found ${matches.length}`);
  }
  if (matches[0][2] !== from) {
    throw new Error(`${file} holds version ${matches[0][2]}, expected ${from}; bring it in line before bumping`);
  }
  return source.replace(pattern, (_, prefix, _version, suffix) => `${prefix}${to}${suffix}`);
}

/** File contents after applying `bumps` ({ core?: {from, to}, mcp?: {from, to} }). */
export function planFileRewrites(bumps, readSource) {
  const files = new Map();
  for (const artifact of ['core', 'mcp']) {
    const bump = bumps[artifact];
    if (!bump) continue;
    for (const target of VERSION_SOURCES[artifact]) {
      const before = files.get(target.file) ?? readSource(target.file);
      files.set(target.file, rewriteVersion(before, target, bump.from, bump.to));
    }
  }
  return files;
}

export function editedFiles(bumps) {
  const files = new Set();
  for (const artifact of ['core', 'mcp']) {
    if (bumps[artifact]) for (const { file } of VERSION_SOURCES[artifact]) files.add(file);
  }
  if (files.size > 0) files.add(LOCKFILE);
  return [...files];
}

/** Decides the bump from plan inputs; pure apart from the tag lookup. */
export function decideBumps({ inputs, renderCoreVersion, core, mcp, tagExists = () => false }) {
  const required = requiredVersionBumps(inputs);
  const bumps = {};
  if (required.core || core) {
    const to = coreBumpTarget({ current: inputs.coreVersion, renderCoreVersion, explicit: core });
    if (tagExists(`core-v${to}`)) throw new Error(`core-v${to} already exists: merge origin/main, which may have released meanwhile, or choose a later version with --core`);
    bumps.core = { from: inputs.coreVersion, to };
  } else {
    assertRenderVersionReleased({ coreVersion: inputs.coreVersion, renderCoreVersion });
  }
  if (required.mcp || mcp) {
    const to = mcpBumpTarget({ current: inputs.mcpVersion, explicit: mcp });
    if (tagExists(`mcp-v${to}`)) throw new Error(`mcp-v${to} already exists: merge origin/main, which may have released meanwhile, or choose a later version with --mcp`);
    bumps.mcp = { from: inputs.mcpVersion, to };
  }
  return bumps;
}

function readSource(file) {
  return readFileSync(path.join(root, file), 'utf8');
}

function dirtyFiles(files) {
  const output = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: root, encoding: 'utf8' });
  return output.split('\n').filter(Boolean).map((line) => line.slice(3));
}

function describe(bumps) {
  return Object.entries(bumps).map(([artifact, { from, to }]) => `${artifact === 'core' ? 'Core' : 'MCP'} ${from} -> ${to}`).join(', ');
}

function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
      core: { type: 'string' },
      mcp: { type: 'string' },
    },
  });
  if (values.core) parseVersion(values.core);
  if (values.mcp) parseVersion(values.mcp);

  const inputs = currentPlanInputs();
  const bumps = decideBumps({
    inputs,
    renderCoreVersion: latestRenderCoreVersion(readSource(RENDER_VERSION_FILE)),
    core: values.core,
    mcp: values.mcp,
    tagExists: (tag) => Boolean(tagSha(tag)),
  });

  if (Object.keys(bumps).length === 0) {
    console.error('Nothing to bump: the release plan already passes.');
    console.log(JSON.stringify(currentPlan(), null, 2));
    return;
  }

  const files = editedFiles(bumps);
  const dirty = dirtyFiles(files);
  if (dirty.length > 0 && !values['allow-dirty'] && !values['dry-run']) {
    throw new Error(`Uncommitted changes in files the bump edits: ${dirty.join(', ')}. Commit or stash them, or pass --allow-dirty.`);
  }

  const rewrites = planFileRewrites(bumps, readSource);
  if (values['dry-run']) {
    console.error(`Would bump ${describe(bumps)}.`);
    for (const file of files) console.error(`  ${file}${file === LOCKFILE ? ' (npm install --package-lock-only)' : ''}`);
    if (dirty.length > 0) console.error(`Uncommitted changes in ${dirty.join(', ')} would require --allow-dirty.`);
    console.log(JSON.stringify({ dry_run: true, bumps, files }, null, 2));
    return;
  }

  for (const [file, contents] of rewrites) writeFileSync(path.join(root, file), contents);
  const lockfile = spawnSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (lockfile.error) throw lockfile.error;
  if (lockfile.status !== 0) throw new Error(`npm install --package-lock-only exited with ${lockfile.status}; version sources are bumped but ${LOCKFILE} is not`);

  console.error(`Bumped ${describe(bumps)}. Add a CHANGELOG.md entry and commit:`);
  for (const file of files) console.error(`  ${file}`);
  console.log(JSON.stringify(currentPlan(), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`release:bump: ${error.message}`);
    process.exit(1);
  }
}
