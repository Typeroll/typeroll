#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildPublishingProbePlan, prepareProbeDirectory } from './lib/customer-publishing-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = path.join(root, 'test-results', 'customer-publishing');
await fs.mkdir(evidenceRoot, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(evidenceRoot, 'smoke-'));
const plan = buildPublishingProbePlan({
  github_owner: 'synthetic-agency', cloudflare_account_id: 'a'.repeat(32),
  github_app_id: '12', github_installation_id: '34', prefix: 'tr-probe-synthetic', media_bucket: 'synthetic-media',
});
await prepareProbeDirectory(plan, path.join(runRoot, 'sites'));
const site = path.join(runRoot, 'sites', plan.repositories[0]);
const guard = path.join(runRoot, 'deny-network.cjs');
await fs.writeFile(guard, `
const deny = () => { throw new Error('Network denied during publication build'); };
for (const name of ['net', 'tls', 'http', 'https']) {
  const api = require(name);
  for (const key of ['connect', 'createConnection', 'request', 'get']) if (typeof api[key] === 'function') api[key] = deny;
}
require('net').Socket.prototype.connect = deny;
require('module').syncBuiltinESMExports();
globalThis.fetch = deny;
`);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: site, encoding: 'utf8', env, timeout: 120_000 });
  if (result.error) throw new Error('Smoke command did not complete');
  return result;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const installation = run(npm, ['ci', '--no-audit', '--no-fund']);
assert.equal(installation.status, 0, installation.stderr);
const isolatedEnv = {
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_OPTIONS: `--require=${JSON.stringify(guard)}`,
};
// Prove the injected guard itself rejects a network attempt.
assert.notEqual(run(process.execPath, ['-e', "fetch('https://example.invalid')"], isolatedEnv).status, 0);
const result = run(process.execPath, ['scripts/build.mjs'], isolatedEnv);
await fs.writeFile(path.join(runRoot, 'build.log'), result.stdout + result.stderr);
assert.equal(result.status, 0, result.stderr);
const dist = path.join(site, 'dist');
const files = await fs.readdir(dist, { recursive: true });
assert.equal(files.filter((file) => file.endsWith('.html')).length, 50);
assert.ok(!files.some((file) => file === '_worker.js' || file.startsWith('functions/')));
for (const route of ['index.html', 'page-50/index.html']) {
  const html = await fs.readFile(path.join(dist, route), 'utf8');
  assert.ok(html.includes('data-probe-revision="published"'));
}
assert.ok((await fs.readFile(path.join(dist, '_headers'), 'utf8')).includes('X-Robots-Tag: noindex'));

// A mutation after publication must fail before rendering.
const contentPath = path.join(site, 'publication.json');
const original = await fs.readFile(contentPath, 'utf8');
try {
  await fs.writeFile(contentPath, original.replace('Synthetic published page 1', 'Unexpected later edit'));
  const mutation = run(process.execPath, ['scripts/build.mjs'], isolatedEnv);
  assert.notEqual(mutation.status, 0);
  assert.ok(mutation.stderr.includes('does not match its frozen manifest'));
} finally { await fs.writeFile(contentPath, original); }

const evidence = { state: 'verified', pages: 50, render_network: 'denied', frozen_content_mutation: 'rejected', plan: plan.fingerprint };
await fs.writeFile(path.join(runRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ...evidence, evidence_directory: path.relative(root, runRoot) }, null, 2));
