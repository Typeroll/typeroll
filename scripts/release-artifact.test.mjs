import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealArtifact, verifyArtifact, digest } from './release-artifact.mjs';
import { verifyDependency } from './release-dependencies.mjs';
import { qualifiedRun } from './qualified-docs.mjs';

test('qualified files cannot be substituted, added, removed or rebound to another source', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-artifact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identity = { source_sha: 'a'.repeat(40), lock_sha256: 'b'.repeat(64), node_version: '22.23.1', target: 'docs-subdirectory' };
  writeFileSync(path.join(dir, 'index.html'), 'qualified'); sealArtifact(dir, identity);
  assert.equal(verifyArtifact(dir, identity).files.length, 1);
  for (const key of Object.keys(identity)) assert.throws(() => verifyArtifact(dir, { ...identity, [key]: 'wrong' }), /mismatch/);
  writeFileSync(path.join(dir, 'index.html'), 'substituted');
  assert.throws(() => verifyArtifact(dir, identity), /files changed/);
  writeFileSync(path.join(dir, 'index.html'), 'qualified');
  writeFileSync(path.join(dir, 'extra.html'), 'unqualified');
  assert.throws(() => verifyArtifact(dir, identity), /files changed/);
  rmSync(path.join(dir, 'extra.html')); rmSync(path.join(dir, 'index.html'));
  assert.throws(() => verifyArtifact(dir, identity), /files changed/);
  symlinkSync('/etc/hosts', path.join(dir, 'index.html'));
  assert.throws(() => verifyArtifact(dir, identity), /Unsupported/);
});

test('only successful exact-source main push qualification can supply docs', () => {
  const run = { conclusion: 'success', status: 'completed', event: 'push', head_branch: 'main', head_sha: 'sha', head_repository: { full_name: 'Typeroll/typeroll' }, path: '.github/workflows/test.yml' };
  assert(qualifiedRun(run, 'Typeroll/typeroll', 'sha'));
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' }, { head_branch: 'other' }, { head_sha: 'other' }, { head_repository: { full_name: 'fork/repo' } }, { path: '.github/workflows/other.yml' }]) {
    assert.equal(qualifiedRun({ ...run, ...change }, 'Typeroll/typeroll', 'sha'), false);
  }
});

test('dependency preflight fails on missing, oversized and changed pinned downloads', async () => {
  const dependency = { name: 'sandbox', url: 'https://example.invalid/file', sha256: digest('ok'), limit: 2 };
  assert.equal((await verifyDependency(dependency, async (_, options) => { assert.equal(options.redirect, 'error'); return new Response('ok'); })).bytes, 2);
  await assert.rejects(verifyDependency(dependency, async () => new Response('', { status: 404 })), /sandbox: HTTP 404/);
  await assert.rejects(verifyDependency(dependency, async () => new Response('no')), /SHA-256 mismatch/);
  await assert.rejects(verifyDependency(dependency, async () => new Response('too long')), /sandbox:/);
});
