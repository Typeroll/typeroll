import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { BUILD_ONLY_WORKSPACES, SHIPPED_WORKSPACES, auditArguments, dependencyFingerprint, evaluateAudit } from './audit-dependencies.mjs';

const approvedUrl = 'https://example.test/approved';
const approvals = new Map([[approvedUrl, { expires: '2027-01-01', rationale: 'Test-only approval.' }]]);
const now = new Date('2026-09-01T00:00:00Z');

function auditWith(vulnerabilities) {
  return { vulnerabilities, metadata: { vulnerabilities: { moderate: Object.keys(vulnerabilities).length } } };
}

test('accepts an approved advisory and its transitive package chain', () => {
  const result = evaluateAudit(
    auditWith({
      parent: { severity: 'moderate', via: ['leaf'] },
      leaf: { severity: 'moderate', via: [{ url: approvedUrl }] },
    }),
    { approvals, now },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.approvedPackages, ['leaf', 'parent']);
});

test('rejects an advisory that is not explicitly approved', () => {
  const result = evaluateAudit(
    auditWith({ leaf: { severity: 'moderate', via: [{ url: 'https://example.test/new' }] } }),
    { approvals, now },
  );

  assert.equal(result.ok, false);
  assert.match(result.failures[0], /unapproved advisory/);
});

test('rejects high severity even when the advisory is approved', () => {
  const result = evaluateAudit(
    auditWith({ leaf: { severity: 'high', via: [{ url: approvedUrl }] } }),
    { approvals, now },
  );

  assert.equal(result.ok, false);
  assert.match(result.failures[0], /high severity/);
});

test('rejects an expired approval', () => {
  const expired = new Map([[approvedUrl, { expires: '2026-09-01', rationale: 'Expired test approval.' }]]);
  const result = evaluateAudit(
    auditWith({ leaf: { severity: 'moderate', via: [{ url: approvedUrl }] } }),
    { approvals: expired, now },
  );

  assert.equal(result.ok, false);
  assert.match(result.failures[0], /approval expired/);
});

test('blocks on every shipped workspace and reports the documentation build separately', () => {
  const packages = new URL('../packages/', import.meta.url);
  const names = readdirSync(packages).map((dir) => JSON.parse(readFileSync(new URL(`${dir}/package.json`, packages), 'utf8')).name);
  assert.deepEqual([...SHIPPED_WORKSPACES, ...BUILD_ONLY_WORKSPACES].sort(), names.sort());
  assert.deepEqual(auditArguments(SHIPPED_WORKSPACES, { includeRoot: true }).slice(0, 3), ['audit', '--json', '--include-workspace-root']);
  assert.ok(!auditArguments(BUILD_ONLY_WORKSPACES, { includeRoot: false }).includes('--include-workspace-root'));
});

test('accepts only the reviewed picomatch advisory on the exact dependency graph', () => {
  const lock = { version: '1', packages: { '': { version: '1' }, 'node_modules/picomatch': { version: '4.0.7', integrity: 'original' } } };
  const url = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
  const now = new Date('2026-11-17T00:00:00Z');
  const approvals = new Map([[url, { expires: '2026-12-01', package: 'picomatch', allowHighSeverity: true, lockFingerprint: dependencyFingerprint(lock) }]]);
  const leaf = { severity: 'high', via: [{ url, name: 'picomatch', severity: 'high' }] };
  const audit = auditWith({ parent: { severity: 'high', via: ['picomatch'] }, picomatch: leaf });
  assert.equal(evaluateAudit(audit, { approvals, now, lock }).ok, true);
  const changed = structuredClone(lock);
  changed.packages['node_modules/picomatch'].integrity = 'different';
  assert.equal(evaluateAudit(audit, { approvals, now, lock: changed }).ok, false);
  assert.equal(evaluateAudit(audit, { approvals, now: new Date('2026-12-01'), lock }).ok, false);
  assert.equal(evaluateAudit(auditWith({ picomatch: { ...leaf, severity: 'critical' } }), { approvals, now, lock }).ok, false);
  assert.equal(evaluateAudit(auditWith({ picomatch: { ...leaf, via: [...leaf.via, { url: 'https://example.test/new', severity: 'high' }] } }), { approvals, now, lock }).ok, false);
  assert.equal(evaluateAudit(auditWith({ other: { ...leaf, via: [{ url, name: 'other', severity: 'high' }] } }), { approvals, now, lock }).ok, false);
  const releaseOnly = structuredClone(lock); releaseOnly.version = '2'; releaseOnly.packages[''].version = '2';
  assert.equal(evaluateAudit(audit, { approvals, now, lock: releaseOnly }).ok, true);
});


test('peer cycles require an approved concrete advisory and retain other failures', () => {
  const graph = {
    first: { severity: 'moderate', via: ['second'] },
    second: { severity: 'moderate', via: ['first', 'leaf'] },
    leaf: { severity: 'moderate', via: [{ url: approvedUrl }] },
  };
  assert.equal(evaluateAudit(auditWith(graph), { approvals, now }).ok, true);
  assert.equal(evaluateAudit(auditWith({ first: { severity: 'moderate', via: ['first'] } }), { approvals, now }).ok, false);
  assert.equal(evaluateAudit(auditWith({ ...graph, leaf: { severity: 'moderate', via: [{ url: 'https://example.test/unapproved' }] } }), { approvals, now }).ok, false);
});
