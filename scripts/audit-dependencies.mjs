#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const APPROVED_ADVISORIES = new Map([
  [
    'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
    {
      expires: '2026-12-01',
      rationale:
        'uuid is pulled in only by firebase-admin optional Cloud Storage dependencies. Typeroll does not import Firebase Storage or call uuid v3/v5/v6 with caller-provided buffers. firebase-admin 14.3.0 supports @google-cloud/storage ^7.22.0, which has no patched release in that major; forcing Storage 8 would violate the upstream dependency contract.',
    },
  ],
]);

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function approvalFor(advisory, now, approvals) {
  const approval = approvals.get(advisory.url);
  if (!approval) return { approved: false, reason: `unapproved advisory ${advisory.url ?? advisory.source ?? 'unknown'}` };

  const expiresAt = new Date(`${approval.expires}T00:00:00Z`);
  if (Number.isNaN(expiresAt.valueOf())) return { approved: false, reason: `invalid approval expiry ${approval.expires}` };
  if (now >= expiresAt) return { approved: false, reason: `approval expired ${approval.expires}` };

  return { approved: true, approval };
}

export function evaluateAudit(audit, options = {}) {
  const now = options.now ?? new Date();
  const approvals = options.approvals ?? APPROVED_ADVISORIES;
  const vulnerabilities = audit?.vulnerabilities ?? {};
  const memo = new Map();
  const visiting = new Set();

  function evaluatePackage(name) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return { approved: false, reasons: [`cyclic vulnerability chain at ${name}`], advisories: [] };

    const vulnerability = vulnerabilities[name];
    if (!vulnerability) return { approved: false, reasons: [`missing vulnerability detail for ${name}`], advisories: [] };
    if (BLOCKING_SEVERITIES.has(vulnerability.severity)) {
      const result = { approved: false, reasons: [`${name} has ${vulnerability.severity} severity`], advisories: [] };
      memo.set(name, result);
      return result;
    }

    visiting.add(name);
    const reasons = [];
    const advisories = [];
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'string') {
        const dependency = evaluatePackage(via);
        reasons.push(...dependency.reasons);
        advisories.push(...dependency.advisories);
        continue;
      }

      const result = approvalFor(via, now, approvals);
      if (!result.approved) reasons.push(`${name}: ${result.reason}`);
      else advisories.push(via.url);
    }
    if ((vulnerability.via ?? []).length === 0) reasons.push(`${name}: vulnerability has no advisory chain`);

    visiting.delete(name);
    const result = {
      approved: reasons.length === 0,
      reasons: [...new Set(reasons)],
      advisories: [...new Set(advisories)],
    };
    memo.set(name, result);
    return result;
  }

  const failures = [];
  const approvedPackages = [];
  for (const name of Object.keys(vulnerabilities).sort()) {
    const result = evaluatePackage(name);
    if (result.approved) approvedPackages.push(name);
    else failures.push(...result.reasons);
  }

  return {
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    approvedPackages,
    metadata: audit?.metadata?.vulnerabilities ?? {},
  };
}

function run() {
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' });
  if (!result.stdout) {
    console.error(result.stderr || 'npm audit returned no JSON output');
    process.exit(1);
  }

  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch (error) {
    console.error(`Could not parse npm audit output: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (audit.error) {
    console.error(audit.error.summary ?? audit.error.message ?? 'npm audit failed');
    process.exit(1);
  }

  const evaluation = evaluateAudit(audit);
  if (!evaluation.ok) {
    console.error('Dependency security audit failed:');
    for (const failure of evaluation.failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  const count = evaluation.approvedPackages.length;
  if (count > 0) {
    console.log(`Dependency security audit passed with ${count} package entries covered by one temporary advisory approval.`);
  } else {
    console.log('Dependency security audit passed with no known advisories.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
