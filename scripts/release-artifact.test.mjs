import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealArtifact, verifyArtifact, digest } from './release-artifact.mjs';
import { BWRAP_SOURCES, BWRAP_SHA } from '../packages/portal/src/lib/builds/executor.mjs';
import { APPARMOR_URL, APPARMOR_SHA } from '../packages/portal/src/lib/builds/github-sandbox.mjs';
import { dependencies, verifyDependency } from './release-dependencies.mjs';
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
  await assert.rejects(verifyDependency(dependency, async () => new Response('', { status: 404 })), /UNAVAILABLE/);
  await assert.rejects(verifyDependency(dependency, async () => new Response('no')), /INTEGRITY/);
  await assert.rejects(verifyDependency(dependency, async () => new Response('too long')), /sandbox/);
});

test('an unreachable host and a substituted artifact are not the same failure', async () => {
  // They call for opposite responses. A host that is down means retry when it
  // is back; bytes that changed at a pinned URL is a supply-chain event that
  // must never be retried away. On 2026-09-22 snapshot.ubuntu.com returned 503
  // for hours and the message was shaped exactly like the dangerous one.
  const dependency = { name: 'sandbox', url: 'https://example.invalid/file', sha256: digest('ok'), limit: 64 };

  for (const response of [
    async () => new Response('', { status: 503 }),
    async () => new Response('', { status: 502 }),
    async () => { throw Error('network unreachable'); },
  ]) {
    await assert.rejects(verifyDependency(dependency, response), (error) => {
      assert.match(error.message, /^UNAVAILABLE:/);
      assert.doesNotMatch(error.message, /INTEGRITY/);
      assert.match(error.message, /its host is/);
      return true;
    });
  }

  await assert.rejects(verifyDependency(dependency, async () => new Response('substituted')), (error) => {
    assert.match(error.message, /^INTEGRITY:/);
    assert.doesNotMatch(error.message, /UNAVAILABLE/);
    // Both hashes present, so the reader can tell what it got from what it wanted.
    assert.match(error.message, new RegExp(digest('substituted')));
    assert.match(error.message, new RegExp(dependency.sha256));
    assert.match(error.message, /Do not retry/);
    return true;
  });
});

test('bubblewrap CI gate accepts a verified fallback and still fails closed on a bad digest', async () => {
  // Same availability rule as acquireSandbox. CI must not block on a single
  // host outage when a verified fallback exists. A reachable source that
  // serves different bytes is INTEGRITY, not an outage to skip past.
  const sources = ['https://upstream.example/bubblewrap.deb', 'https://mirror.example/bubblewrap.deb'];
  const body = 'pinned sandbox';
  const bubblewrap = { name: 'bubblewrap', urls: sources, sha256: digest(body) };
  const profile = { name: 'apparmor-profile', url: 'https://apparmor.example/profile', sha256: digest('profile'), limit: 64 };
  const fetchFrom = (upstream) => async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url === profile.url) return new Response('profile');
    if (url === sources[0]) return upstream();
    if (url === sources[1]) return new Response(body);
    throw Error(`unexpected ${url}`);
  };

  const passed = [
    await verifyDependency(bubblewrap, fetchFrom(() => new Response('', { status: 503 }))),
    await verifyDependency(profile, fetchFrom(() => new Response('', { status: 503 }))),
  ];
  assert.equal(passed[0].name, 'bubblewrap');
  assert.equal(passed[0].sha256, bubblewrap.sha256);
  assert.equal(passed[0].bytes, body.length);
  assert.equal(passed[1].name, 'apparmor-profile');

  await assert.rejects(
    verifyDependency(bubblewrap, async (url) => {
      assert.ok(sources.includes(url));
      return new Response('', { status: 503 });
    }),
    (error) => {
      assert.match(error.message, /^UNAVAILABLE:/);
      assert.doesNotMatch(error.message, /INTEGRITY/);
      assert.match(error.message, /upstream\.example/);
      assert.match(error.message, /mirror\.example/);
      return true;
    },
  );

  let mirrorFetches = 0;
  await assert.rejects(verifyDependency(bubblewrap, async (url) => {
    if (url === sources[1]) mirrorFetches += 1;
    if (url === sources[0]) return new Response('substituted');
    return new Response(body);
  }), (error) => {
    assert.match(error.message, /^INTEGRITY:/);
    assert.doesNotMatch(error.message, /UNAVAILABLE/);
    assert.match(error.message, new RegExp(digest('substituted')));
    assert.match(error.message, new RegExp(bubblewrap.sha256));
    assert.equal(mirrorFetches, 0);
    return true;
  });
});

test('the release gate lists upstream first and still pins apparmor on its own', () => {
  assert.equal(dependencies.filter(dependency => dependency.sha256 === BWRAP_SHA).length, 1);
  assert.deepEqual(dependencies[0].urls, BWRAP_SOURCES);
  assert.match(dependencies[0].urls[0], /snapshot\.ubuntu\.com/);
  assert.equal(dependencies[1].url, APPARMOR_URL);
  assert.equal(dependencies[1].sha256, APPARMOR_SHA);
});
