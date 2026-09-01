import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAudit } from './audit-dependencies.mjs';

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
