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
    file === 'scripts/oss-release-plan.mjs' ||
    file === 'scripts/oss-release-plan.test.mjs' ||
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
    mcp: normalized.some((file) => file.startsWith('packages/mcp-server/') || file.startsWith('packages/shared/')),
    docs: normalized.some(docsOnly),
  };
}

export function buildReleasePlan({ sourceSha, coreVersion, mcpVersion, coreTagSha, mcpTagSha, coreChanges = [], mcpChanges = [] }) {
  if (!GIT_SHA.test(sourceSha)) throw new Error('source SHA must be a full lowercase Git SHA');
  if (!STABLE_VERSION.test(coreVersion)) throw new Error('Core version must be stable semantic version');
  if (!STABLE_VERSION.test(mcpVersion)) throw new Error('MCP version must be stable semantic version');

  const coreTag = `core-v${coreVersion}`;
  const mcpTag = `mcp-v${mcpVersion}`;
  if (coreTagSha && coreTagSha !== sourceSha && releaseScopes(coreChanges).core) {
    throw new Error(`${coreTag} already points to ${coreTagSha}, but Core-relevant files changed; bump the Core version`);
  }
  if (mcpTagSha && mcpTagSha !== sourceSha && releaseScopes(mcpChanges).mcp) {
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

export function buildReleaseManifest({ repositoryRoot = root, sourceSha, imageDigest, recordedAt = new Date().toISOString().slice(0, 10) }) {
  if (!GIT_SHA.test(sourceSha)) throw new Error('source SHA must be a full lowercase Git SHA');
  if (!SHA256.test(imageDigest)) throw new Error('image digest must be an immutable lowercase sha256 digest');
  const manifest = {
    schema_version: 1,
    repository: 'Typeroll/typeroll',
    source_commit: sourceSha,
    core_version: readJson(repositoryRoot, 'package.json').version,
    image_digest: imageDigest,
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
    mcp_version: readJson(repositoryRoot, 'packages/mcp-server/package.json').version,
    recorded_at: recordedAt,
  };
  if (!STABLE_VERSION.test(manifest.core_version) || !STABLE_VERSION.test(manifest.mcp_version)) {
    throw new Error('release manifest versions must be stable semantic versions');
  }
  return manifest;
}

function tagSha(tag) {
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

function currentPlan() {
  const sourceSha = git(['rev-parse', 'HEAD']);
  const coreVersion = readJson(root, 'package.json').version;
  const mcpVersion = readJson(root, 'packages/mcp-server/package.json').version;
  const coreTagSha = tagSha(`core-v${coreVersion}`);
  const mcpTagSha = tagSha(`mcp-v${mcpVersion}`);
  const localChanges = workingTreeChanges();
  return buildReleasePlan({
    sourceSha,
    coreVersion,
    mcpVersion,
    coreTagSha,
    mcpTagSha,
    coreChanges: [...new Set([...changesSince(coreTagSha), ...localChanges])],
    mcpChanges: [...new Set([...changesSince(mcpTagSha), ...localChanges])],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'github-output': { type: 'boolean', default: false },
      manifest: { type: 'string' },
      'source-sha': { type: 'string' },
      'image-digest': { type: 'string' },
    },
  });
  if (values.manifest) {
    const manifest = buildReleaseManifest({ sourceSha: values['source-sha'], imageDigest: values['image-digest'] });
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
