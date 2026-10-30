import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  VERSION_SOURCES,
  compareVersions,
  coreBumpTarget,
  decideBumps,
  editedFiles,
  latestRenderCoreVersion,
  mcpBumpTarget,
  nextPatch,
  parseVersion,
  planFileRewrites,
  rewriteVersion,
} from './oss-release-bump.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);

const FIXTURES = {
  'package.json': '{\n  "name": "typeroll",\n  "version": "1.2.3",\n  "dependencies": {\n    "x": {\n      "version": "9.9.9"\n    }\n  }\n}\n',
  'packages/shared/src/release.ts': "/** Core. */\nexport const CORE_VERSION = '1.2.3';\n\nexport const DATA_SCHEMA_VERSION = 2;\n",
  'scripts/lib/self-host-schema.mjs': "export const SELF_HOST_BACKUP_FORMAT_VERSION = 1;\nexport const SELF_HOST_CORE_VERSION = '1.2.3';\n",
  'scripts/oss-release-plan.test.mjs': "  assert.equal(manifest.core_version, '1.2.3');\n  assert.equal(manifest.mcp_version, '4.5.6');\n",
  'packages/mcp-server/package.json': '{\n  "name": "@typeroll/mcp-server",\n  "version": "4.5.6",\n  "license": "MIT"\n}\n',
  'packages/mcp-server/src/version.ts': "// Keep in lockstep with package.json.\nexport const VERSION = '4.5.6';\n",
};

const readFixture = (file) => {
  if (!(file in FIXTURES)) throw new Error(`unexpected read of ${file}`);
  return FIXTURES[file];
};

function inputs(overrides = {}) {
  return { sourceSha: SHA, coreVersion: '1.2.3', mcpVersion: '4.5.6', coreTagSha: SHA, mcpTagSha: SHA,
    coreChanges: [], mcpChanges: [], ...overrides };
}

test('versions are parsed, compared and patch-incremented as stable semver', () => {
  assert.deepEqual(parseVersion('0.2.132'), [0, 2, 132]);
  assert.equal(nextPatch('0.2.132'), '0.2.133');
  assert.equal(nextPatch('0.45.99'), '0.45.100');
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.3.0', '0.2.200'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const bad of ['0.2', '0.2.1-rc.1', 'v0.2.1', '01.2.3', '', undefined]) {
    assert.throws(() => parseVersion(bad), /not a stable semantic version/);
  }
});

test('a Core and MCP bump rewrites every version source and nothing else', () => {
  const files = planFileRewrites({ core: { from: '1.2.3', to: '1.2.4' }, mcp: { from: '4.5.6', to: '4.6.0' } }, readFixture);
  assert.deepEqual([...files.keys()].sort(), Object.keys(FIXTURES).sort());
  assert.match(files.get('package.json'), /^ {2}"version": "1\.2\.4",$/m);
  assert.match(files.get('package.json'), /"version": "9\.9\.9"/);
  assert.match(files.get('packages/shared/src/release.ts'), /CORE_VERSION = '1\.2\.4';/);
  assert.match(files.get('packages/shared/src/release.ts'), /DATA_SCHEMA_VERSION = 2;/);
  assert.match(files.get('scripts/lib/self-host-schema.mjs'), /SELF_HOST_CORE_VERSION = '1\.2\.4';/);
  assert.equal(files.get('scripts/oss-release-plan.test.mjs'),
    "  assert.equal(manifest.core_version, '1.2.4');\n  assert.equal(manifest.mcp_version, '4.6.0');\n");
  assert.match(files.get('packages/mcp-server/package.json'), /"version": "4\.6\.0",/);
  assert.match(files.get('packages/mcp-server/src/version.ts'), /VERSION = '4\.6\.0';/);
});

test('a Core-only bump leaves MCP sources untouched and edits the lockfile', () => {
  const bumps = { core: { from: '1.2.3', to: '1.2.4' } };
  const files = planFileRewrites(bumps, readFixture);
  assert.equal(files.has('packages/mcp-server/package.json'), false);
  assert.match(files.get('scripts/oss-release-plan.test.mjs'), /mcp_version, '4\.5\.6'/);
  assert.deepEqual(editedFiles(bumps), [...VERSION_SOURCES.core.map(({ file }) => file), 'package-lock.json']);
  assert.deepEqual(editedFiles({}), []);
});

test('a version source that drifted from package.json is refused', () => {
  const [release] = VERSION_SOURCES.core.filter(({ file }) => file === 'packages/shared/src/release.ts');
  assert.throws(() => rewriteVersion("export const CORE_VERSION = '1.2.2';\n", release, '1.2.3', '1.2.4'),
    /holds version 1\.2\.2, expected 1\.2\.3/);
  assert.throws(() => rewriteVersion('export const OTHER = 1;\n', release, '1.2.3', '1.2.4'), /found 0/);
  assert.throws(() => rewriteVersion(FIXTURES['packages/shared/src/release.ts'], release, '1.2.3', '1.3'),
    /not a stable semantic version/);
});

test('the Core bump lands on the release a pending render version declares', () => {
  const source = "{ version: 11, core_version: '0.2.115' },\n{ version: 12, core_version: '0.2.133' },\n{ version: 3, core_version: '0.2.58' }";
  assert.equal(latestRenderCoreVersion(source), '0.2.133');
  assert.throws(() => latestRenderCoreVersion('export const X = 1;'), /No render version/);

  assert.equal(coreBumpTarget({ current: '0.2.132', renderCoreVersion: '0.2.132' }), '0.2.133');
  assert.equal(coreBumpTarget({ current: '0.2.132', renderCoreVersion: '0.2.57' }), '0.2.133');
  assert.equal(coreBumpTarget({ current: '0.2.132', renderCoreVersion: '0.2.133' }), '0.2.133');
  assert.equal(coreBumpTarget({ current: '0.2.132', renderCoreVersion: '0.3.0' }), '0.3.0');
  assert.equal(coreBumpTarget({ current: '0.2.132', renderCoreVersion: '0.3.0', explicit: '0.3.0' }), '0.3.0');
  assert.throws(() => coreBumpTarget({ current: '0.2.132', renderCoreVersion: '0.2.133', explicit: '0.3.0' }),
    /disagrees with .*render-version\.ts.*Core 0\.2\.133/);
  assert.throws(() => coreBumpTarget({ current: '0.2.132', renderCoreVersion: '0.2.132', explicit: '0.2.132' }),
    /must be greater/);
  assert.throws(() => mcpBumpTarget({ current: '0.45.96', explicit: '0.45.90' }), /must be greater/);
  assert.equal(mcpBumpTarget({ current: '0.45.96', explicit: '0.46.0' }), '0.46.0');
});

test('the bump follows the release plan and is idempotent once it passes', () => {
  const renderCoreVersion = '1.2.3';
  assert.deepEqual(decideBumps({ inputs: inputs({ coreChanges: ['docs/x.md'] }), renderCoreVersion }), {});
  assert.deepEqual(decideBumps({ inputs: inputs({ coreTagSha: '', mcpTagSha: '',
    coreChanges: ['packages/portal/src/index.ts'] }), renderCoreVersion }), {});

  assert.deepEqual(decideBumps({ inputs: inputs({ coreChanges: ['packages/portal/src/index.ts'],
    mcpChanges: ['packages/portal/src/index.ts'] }), renderCoreVersion }), { core: { from: '1.2.3', to: '1.2.4' } });
  assert.deepEqual(decideBumps({ inputs: inputs({ coreChanges: ['packages/mcp-server/src/index.ts'],
    mcpChanges: ['packages/mcp-server/src/index.ts'] }), renderCoreVersion }),
  { core: { from: '1.2.3', to: '1.2.4' }, mcp: { from: '4.5.6', to: '4.5.7' } });
  assert.deepEqual(decideBumps({ inputs: inputs(), renderCoreVersion, core: '1.3.0', mcp: '4.6.0' }),
    { core: { from: '1.2.3', to: '1.3.0' }, mcp: { from: '4.5.6', to: '4.6.0' } });

  assert.throws(() => decideBumps({ inputs: inputs({ coreChanges: ['packages/portal/src/index.ts'] }),
    renderCoreVersion, tagExists: (tag) => tag === 'core-v1.2.4' }), /core-v1\.2\.4 already exists/);
});

test('an unbumped Core cannot publish a render version declared for a later release', () => {
  assert.throws(() => decideBumps({ inputs: inputs({ coreTagSha: '' }), renderCoreVersion: '1.2.4' }),
    /introduced in Core 1\.2\.4, but this tree publishes Core 1\.2\.3/);
});

test('the repository version sources agree with each other', () => {
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const coreVersion = JSON.parse(read('package.json')).version;
  const mcpVersion = JSON.parse(read('packages/mcp-server/package.json')).version;
  const bump = (version) => ({ from: version, to: nextPatch(version) });
  assert.doesNotThrow(() => planFileRewrites({ core: bump(coreVersion), mcp: bump(mcpVersion) }, read));
  assert.doesNotThrow(() => latestRenderCoreVersion(read('packages/shared/src/render-version.ts')));
});
