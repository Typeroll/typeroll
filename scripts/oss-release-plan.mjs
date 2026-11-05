#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

function git(args, repositoryRoot = root) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readJson(repositoryRoot, relative) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'));
}

function readLiteral(repositoryRoot, relative, exportName) {
  const source = readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const match = source.match(
    new RegExp(`(?:export const ${exportName} =|${exportName}:)\\s*(?:['"]([^'"]+)['"]|(\\d+))(?: as const)?[,;]`),
  );
  if (!match) throw new Error(`Could not read ${exportName} from ${relative}`);
  return match[1] ?? Number(match[2]);
}

export function releaseScopes(files) {
  const normalized = files.filter(Boolean);
  const infrastructureOnly = (file) =>
    file.startsWith('.github/') ||
    ['scripts/release-artifact.mjs', 'scripts/release-artifact.test.mjs', 'scripts/release-worker-bundle.mjs', 'scripts/release-worker-bundle.test.mjs', 'scripts/lib/worker-bundle.mjs', 'scripts/release-dependencies.mjs', 'scripts/qualified-docs.mjs', 'scripts/source-check-plan.mjs', 'scripts/source-check-plan.test.mjs'].includes(file) ||
    file === 'scripts/oss-release-plan.mjs' ||
    file === 'scripts/oss-release-plan.test.mjs' ||
    file === 'scripts/oss-release-bump.mjs' ||
    file === 'scripts/oss-release-bump.test.mjs' ||
    file === 'scripts/oss-release-check.mjs' ||
    file === 'scripts/oss-release-check.test.mjs' ||
    file === 'scripts/mcp-publish-workflow.test.mjs' ||
    file === 'scripts/oss-boundary.test.mjs' ||
    file === 'docs/releasing.md';
  const docsOnly = (file) =>
    file.startsWith('docs/') ||
    file.startsWith('packages/docs-site/') ||
    ['AGENTS.md', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE'].includes(file);
  return {
    core: normalized.some((file) => !infrastructureOnly(file) && !docsOnly(file)),
    // The standalone MCP package neither imports nor ships Core's release
    // metadata. Other shared contract changes still require an MCP release.
    mcp: normalized.some((file) => file.startsWith('packages/mcp-server/') ||
      (file.startsWith('packages/shared/') && file !== 'packages/shared/src/release.ts')),
    docs: normalized.some(docsOnly),
  };
}

/** Which versions are already tagged but have relevant changes since that tag. */
export function requiredVersionBumps({ coreTagSha, mcpTagSha, coreChanges = [], mcpChanges = [] }) {
  return {
    core: Boolean(coreTagSha) && releaseScopes(coreChanges).core,
    mcp: Boolean(mcpTagSha) && releaseScopes(mcpChanges).mcp,
  };
}

export function buildReleasePlan({ sourceSha, coreVersion, mcpVersion, coreTagSha, mcpTagSha, coreChanges = [], mcpChanges = [] }) {
  if (!GIT_SHA.test(sourceSha)) throw new Error('source SHA must be a full lowercase Git SHA');
  if (!STABLE_VERSION.test(coreVersion)) throw new Error('Core version must be stable semantic version');
  if (!STABLE_VERSION.test(mcpVersion)) throw new Error('MCP version must be stable semantic version');

  const coreTag = `core-v${coreVersion}`;
  const mcpTag = `mcp-v${mcpVersion}`;
  const bumps = requiredVersionBumps({ coreTagSha, mcpTagSha, coreChanges, mcpChanges });
  if (bumps.core) {
    throw new Error(`${coreTag} already points to ${coreTagSha}, but Core-relevant files changed; bump the Core version`);
  }
  if (bumps.mcp) {
    throw new Error(`${mcpTag} already points to ${mcpTagSha}, but MCP-relevant files changed; bump the MCP version`);
  }

  return {
    source_sha: sourceSha,
    core_source_sha: coreTagSha || sourceSha,
    core_version: coreVersion,
    core_tag: coreTag,
    publish_core: !coreTagSha,
    mcp_version: mcpVersion,
    mcp_tag: mcpTag,
    publish_mcp: !mcpTagSha,
  };
}

export const BUNDLE_PROVENANCE = {
  predicate_type: 'https://slsa.dev/provenance/v1',
  signer_workflow: 'Typeroll/typeroll/.github/workflows/publish-mcp.yml',
  source_ref: 'refs/heads/main',
};

/**
 * The Cloud-consumable lock for one released Core. `bundle` is the descriptor
 * that release-worker-bundle.mjs wrote next to the published tarball; Cloud
 * verifies the tarball against `bundle_digest` and its GitHub attestation
 * against `bundle.provenance` before deploying it.
 */
export function buildReleaseManifest({ repositoryRoot = root, sourceSha, bundle, recordedAt = new Date().toISOString().slice(0, 10) }) {
  if (!GIT_SHA.test(sourceSha)) throw new Error('source SHA must be a full lowercase Git SHA');
  if (!SHA256.test(bundle?.sha256 ?? '')) throw new Error('bundle digest must be an immutable lowercase sha256 digest');
  const coreVersion = readJson(repositoryRoot, 'package.json').version;
  const release = bundle.release ?? {};
  const manifest = {
    schema_version: 2,
    repository: 'Typeroll/typeroll',
    source_commit: sourceSha,
    core_version: coreVersion,
    bundle_digest: bundle.sha256,
    bundle: {
      asset: bundle.asset,
      url: `https://github.com/Typeroll/typeroll/releases/download/core-v${coreVersion}/${bundle.asset}`,
      size: bundle.size,
      content_sha256: release.content_sha256,
      provenance: BUNDLE_PROVENANCE,
      build: release.build,
      workers: release.workers,
      roles: release.roles,
    },
    data_schema_version: readLiteral(repositoryRoot, 'packages/shared/src/release.ts', 'DATA_SCHEMA_VERSION'),
    data_schema_readable: {
      min: readLiteral(repositoryRoot, 'packages/shared/src/release.ts', 'DATA_SCHEMA_READABLE_MIN'),
      max: readLiteral(repositoryRoot, 'packages/shared/src/release.ts', 'DATA_SCHEMA_READABLE_MAX'),
    },
    template_capabilities_version: readLiteral(
      repositoryRoot,
      'packages/shared/src/site-template-capabilities.ts',
      'template_capabilities_version',
    ),
    extension_host_protocol_version: readLiteral(
      repositoryRoot,
      'packages/shared/src/extensions.ts',
      'EXTENSION_HOST_PROTOCOL_VERSION',
    ),
    extension_runtime_version: readLiteral(
      repositoryRoot,
      'packages/shared/src/extensions.ts',
      'EXTENSION_RUNTIME_VERSION',
    ),
    // The narrow internal API the private operator Worker calls through its
    // service binding to the portal's OperatorApi entrypoint.
    operator_api_version: readLiteral(repositoryRoot, 'packages/portal/src/lib/operator-api/contract.ts', 'OPERATOR_API_VERSION'),
    // The RPC contract a hosting service bound as SITE_HOSTING implements for sites in the `hosted` mode.
    site_hosting_version: readLiteral(repositoryRoot, 'packages/portal/src/lib/publishing/site-hosting.ts', 'SITE_HOSTING_VERSION'),
    mcp_version: readJson(repositoryRoot, 'packages/mcp-server/package.json').version,
    recorded_at: recordedAt,
  };
  if (!STABLE_VERSION.test(manifest.core_version) || !STABLE_VERSION.test(manifest.mcp_version)) {
    throw new Error('release manifest versions must be stable semantic versions');
  }
  if (!release.workers?.portal?.exports?.includes('OperatorApi')) throw new Error('bundle exports no OperatorApi entrypoint for the operator');
  const mismatches = [
    ['source_sha', release.source_sha, sourceSha],
    ['core_version', release.core_version, manifest.core_version],
    ['data_schema_version', release.data_schema_version, manifest.data_schema_version],
    ['data_schema_readable', JSON.stringify(release.data_schema_readable), JSON.stringify(manifest.data_schema_readable)],
    ['asset', bundle.asset, `typeroll-core-${manifest.core_version}-workers.tar.gz`],
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length) {
    throw new Error(`bundle does not belong to this release: ${mismatches.map(([key, actual, expected]) => `${key}=${actual} (expected ${expected})`).join(', ')}`);
  }
  if (!release.workers?.portal?.migration_tag) throw new Error('bundle contract names no portal Worker with a Durable Object migration');
  return manifest;
}

export function tagSha(tag) {
  try {
    return git(['rev-list', '-n', '1', tag]);
  } catch {
    return '';
  }
}

function changesSince(tagShaValue) {
  if (!tagShaValue) return [];
  const output = git(['diff', '--name-only', tagShaValue, 'HEAD']);
  return output ? output.split('\n') : [];
}

function workingTreeChanges() {
  const tracked = git(['diff', '--name-only', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([
    ...(tracked ? tracked.split('\n') : []),
    ...(untracked ? untracked.split('\n') : []),
  ])];
}

/** The inputs `buildReleasePlan` judges for this checkout, including uncommitted work. */
export function currentPlanInputs() {
  const sourceSha = git(['rev-parse', 'HEAD']);
  const coreVersion = readJson(root, 'package.json').version;
  const mcpVersion = readJson(root, 'packages/mcp-server/package.json').version;
  const coreTagSha = tagSha(`core-v${coreVersion}`);
  const mcpTagSha = tagSha(`mcp-v${mcpVersion}`);
  const localChanges = workingTreeChanges();
  return {
    sourceSha,
    coreVersion,
    mcpVersion,
    coreTagSha,
    mcpTagSha,
    coreChanges: [...new Set([...changesSince(coreTagSha), ...localChanges])],
    mcpChanges: [...new Set([...changesSince(mcpTagSha), ...localChanges])],
  };
}

export function currentPlan() {
  return buildReleasePlan(currentPlanInputs());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'github-output': { type: 'boolean', default: false },
      manifest: { type: 'string' },
      'source-sha': { type: 'string' },
      bundle: { type: 'string' },
    },
  });
  if (values.manifest) {
    if (!values.bundle) throw new Error('--bundle DESCRIPTOR is required with --manifest');
    const bundle = JSON.parse(readFileSync(path.resolve(values.bundle), 'utf8'));
    const manifest = buildReleaseManifest({ sourceSha: values['source-sha'], bundle });
    writeFileSync(path.resolve(values.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote OSS release manifest to ${values.manifest}.`);
  } else {
    const plan = currentPlan();
    if (values['github-output']) {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required with --github-output');
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `${Object.entries(plan).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
      );
    }
    console.log(JSON.stringify(plan, null, 2));
  }
}
