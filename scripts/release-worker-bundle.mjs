#!/usr/bin/env node
// Builds, packs and verifies the Core Worker release bundle.
//
//   release-worker-bundle.mjs build --out DIR [--skip-build]
//   release-worker-bundle.mjs verify --dir DIR --source-sha SHA --core-tag core-vX.Y.Z
//
// The bundle is exactly the `@astrojs/cloudflare` output of packages/portal
// (dist/server with its generated wrangler.json, dist/client assets) plus a
// release.json contract. Cloud deploys this tarball unchanged: it derives the
// staging/production wrangler configuration next to the bundled one and runs
// `wrangler versions upload`, which never rebundles (no_bundle: true). Forms is
// the same bundle deployed as a second script with SERVICE_ROLE=forms.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BUNDLE_KIND, BUNDLE_SCHEMA_VERSION, RELEASE_FILE, collectFiles, contentDigest, gunzip, gzipDeterministic,
  inventoryOf, moduleExports, packTar, readTar, sha256, workerContract,
} from './lib/worker-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function assetNames(coreVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(coreVersion ?? '')) throw Error(`Invalid Core version: ${coreVersion}`);
  const base = `typeroll-core-${coreVersion}-workers`;
  return { tarball: `${base}.tar.gz`, descriptor: `${base}.json` };
}

function literal(repositoryRoot, relative, name) {
  const source = readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const match = source.match(new RegExp(`export const ${name} = (?:['"]([^'"]+)['"]|(\\d+));`));
  if (!match) throw Error(`Could not read ${name} from ${relative}`);
  return match[1] ?? Number(match[2]);
}

/** The Core release facts the bundle carries. */
export function releaseFacts(repositoryRoot = root) {
  const release = 'packages/shared/src/release.ts';
  return {
    core_version: JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version,
    data_schema_version: literal(repositoryRoot, release, 'DATA_SCHEMA_VERSION'),
    data_schema_readable: {
      min: literal(repositoryRoot, release, 'DATA_SCHEMA_READABLE_MIN'),
      max: literal(repositoryRoot, release, 'DATA_SCHEMA_READABLE_MAX'),
    },
  };
}

/** Inputs that must match for a rebuild to reproduce the same bytes. */
export function buildIdentity(repositoryRoot = root, runtime = process.versions.node) {
  return {
    source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    lock_sha256: sha256(readFileSync(path.join(repositoryRoot, 'package-lock.json'))),
    node_version: runtime,
    wrangler_version: JSON.parse(readFileSync(path.join(repositoryRoot, 'node_modules/wrangler/package.json'), 'utf8')).version,
    // Astro embeds absolute source paths ($$file), so the checkout path is an input.
    build_root: repositoryRoot,
  };
}

/** Pack a portal build output (`dist/` with server/ and client/) into the release bundle. */
export function buildBundle({ distDirectory, identity, facts }) {
  if (!GIT_SHA.test(identity.source_sha ?? '')) throw Error('source SHA must be a full lowercase Git SHA');
  const excluded = [];
  const files = [
    ...collectFiles(path.join(distDirectory, 'server'), 'portal/server', excluded),
    ...collectFiles(path.join(distDirectory, 'client'), 'portal/client', excluded),
  ];
  const byPath = new Map(files.map(file => [file.path, file.data]));
  const configBytes = byPath.get('portal/server/wrangler.json');
  if (!configBytes) throw Error('The build output has no server/wrangler.json; build with @astrojs/cloudflare');
  const config = JSON.parse(configBytes.toString('utf8'));
  const mainSource = byPath.get(`portal/server/${config.main}`);
  if (!mainSource) throw Error(`The Worker entry ${config.main} is missing from the build output`);
  if (config.assets && path.posix.normalize(`server/${config.assets.directory}`) !== 'client') {
    throw Error(`Assets must come from dist/client, not ${config.assets.directory}`);
  }
  const { errors, contract } = workerContract(config, { exports: moduleExports(mainSource.toString('utf8')), directory: 'portal' });
  if (errors.length) throw Error(`The portal Worker breaks the release contract:\n- ${errors.join('\n- ')}`);

  const inventory = inventoryOf(files);
  const { source_sha: sourceSha, ...build } = identity;
  const release = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    ...facts,
    source_sha: sourceSha,
    build,
    workers: { portal: contract },
    // Deployed scripts per role. Forms runs the portal bundle with its own
    // name, routes and SERVICE_ROLE, binding the portal script's store class.
    roles: {
      portal: { worker: 'portal' },
      forms: { worker: 'portal', vars: { SERVICE_ROLE: 'forms' }, store: 'portal' },
    },
    content_sha256: contentDigest(inventory),
    files: inventory,
  };
  const tar = packTar([...files, { path: RELEASE_FILE, data: Buffer.from(`${JSON.stringify(release, null, 2)}\n`) }]);
  const tarball = gzipDeterministic(tar);
  const names = assetNames(facts.core_version);
  const { files: _files, ...summary } = release;
  const descriptor = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    asset: names.tarball,
    sha256: `sha256:${sha256(tarball)}`,
    size: tarball.length,
    release: summary,
  };
  return { tarball, descriptor, excluded };
}

/** Verify a tarball against its descriptor and the expected Core release. */
export function verifyBundle(tarball, descriptor, expected = {}) {
  const digest = `sha256:${sha256(tarball)}`;
  if (!DIGEST.test(descriptor?.sha256 ?? '') || descriptor.sha256 !== digest) throw Error(`Bundle digest ${digest} does not match the descriptor ${descriptor?.sha256}`);
  if (expected.sha256 && expected.sha256 !== digest) throw Error(`Bundle digest ${digest} is not the pinned ${expected.sha256}`);
  if (descriptor.size !== tarball.length) throw Error('Bundle size does not match the descriptor');
  const files = readTar(gunzip(tarball));
  const releaseEntry = files.find(file => file.path === RELEASE_FILE);
  if (!releaseEntry) throw Error('Bundle has no release.json');
  const release = JSON.parse(releaseEntry.data.toString('utf8'));
  const inventory = inventoryOf(files.filter(file => file.path !== RELEASE_FILE));
  if (JSON.stringify(inventory) !== JSON.stringify(release.files)) throw Error('Bundle files do not match its release inventory');
  if (contentDigest(inventory) !== release.content_sha256) throw Error('Bundle content digest mismatch');
  const { files: _files, ...summary } = release;
  if (JSON.stringify(summary) !== JSON.stringify(descriptor.release)) throw Error('Bundle release contract does not match the descriptor');
  if (release.kind !== BUNDLE_KIND || release.schema_version !== BUNDLE_SCHEMA_VERSION) throw Error('Not a Typeroll Core Worker bundle');
  if (descriptor.asset !== assetNames(release.core_version).tarball) throw Error('Bundle asset name does not match its Core version');
  if (expected.source_sha && release.source_sha !== expected.source_sha) throw Error(`Bundle was built from ${release.source_sha}, not ${expected.source_sha}`);
  if (expected.core_version && release.core_version !== expected.core_version) throw Error(`Bundle is Core ${release.core_version}, not ${expected.core_version}`);
  return release;
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...options.env } });
}

/** Extract into an empty directory (used for the wrangler dry run and local smoke tests). */
export function extractBundle(tarball, directory) {
  for (const file of readTar(gunzip(tarball))) {
    const target = path.join(directory, file.path);
    if (!target.startsWith(path.resolve(directory) + path.sep)) throw Error(`Unsafe bundle path: ${file.path}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      dir: { type: 'string' },
      'skip-build': { type: 'boolean', default: false },
      'source-sha': { type: 'string' },
      'core-tag': { type: 'string' },
    },
  });
  const [action] = positionals;
  if (action === 'build') {
    if (!values.out) throw Error('Usage: release-worker-bundle.mjs build --out DIR [--skip-build]');
    if (!values['skip-build']) {
      // The frozen publication renderer travels with the Worker as a static asset.
      run(process.execPath, [path.join(root, 'scripts/build-static-publication-template.mjs')]);
      run('npm', ['run', 'build', '--workspace=@typeroll/portal']);
    }
    if (!existsSync(path.join(root, 'packages/portal/dist/client/_typeroll/publication-template.json'))) {
      throw Error('The build output has no _typeroll/publication-template.json; run scripts/build-static-publication-template.mjs before building the portal');
    }
    const facts = releaseFacts();
    const { tarball, descriptor, excluded } = buildBundle({ distDirectory: path.join(root, 'packages/portal/dist'), identity: buildIdentity(), facts });
    const out = path.resolve(values.out);
    mkdirSync(out, { recursive: true });
    const names = assetNames(facts.core_version);
    writeFileSync(path.join(out, names.tarball), tarball);
    writeFileSync(path.join(out, names.descriptor), `${JSON.stringify(descriptor, null, 2)}\n`);
    // Prove the exact packed bytes are uploadable without contacting Cloudflare.
    const scratch = mkdtempSync(path.join(tmpdir(), 'typeroll-workers-'));
    try {
      extractBundle(tarball, scratch);
      run(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run',
        '--config', path.join(scratch, 'portal/server/wrangler.json'), '--outdir', path.join(scratch, 'dry-run')]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    writeOutputs({ bundle_digest: descriptor.sha256, tarball: names.tarball, descriptor: names.descriptor });
    console.log(JSON.stringify({ action, asset: descriptor.asset, sha256: descriptor.sha256, size: descriptor.size, files: descriptor.release.content_sha256, excluded }));
  } else if (action === 'verify') {
    const tag = values['core-tag']?.match(/^core-v(\d+\.\d+\.\d+)$/)?.[1];
    if (!values.dir || !GIT_SHA.test(values['source-sha'] ?? '') || !tag) throw Error('Usage: release-worker-bundle.mjs verify --dir DIR --source-sha SHA --core-tag core-vX.Y.Z');
    const names = assetNames(tag);
    const descriptor = JSON.parse(readFileSync(path.join(values.dir, names.descriptor), 'utf8'));
    const release = verifyBundle(readFileSync(path.join(values.dir, names.tarball)), descriptor, { source_sha: values['source-sha'], core_version: tag });
    writeOutputs({ bundle_digest: descriptor.sha256, tarball: names.tarball, descriptor: names.descriptor });
    console.log(JSON.stringify({ action, asset: descriptor.asset, sha256: descriptor.sha256, source_sha: release.source_sha, migration_tag: release.workers.portal.migration_tag }));
  } else {
    throw Error('Usage: release-worker-bundle.mjs build|verify ...');
  }
}
