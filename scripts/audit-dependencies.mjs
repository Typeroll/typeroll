#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Owner-approved continuation of the unchanged production dependency graph.
// This accepts existing risk; it does not claim the vulnerable code is unreachable.
export const APPROVED_ADVISORIES = new Map([[
  'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  { expires: '2026-12-01', package: 'picomatch', allowHighSeverity: true,
    lockFingerprint: 'd81815b3c75465cc8bcc2f252ef2f180752d515d169332e5971e09f72466fa0e',
    rationale: 'Approved 2026-11-17: unchanged production dependencies and no new glob input paths; review or upgrade by December 1. See docs/security-advisory-exceptions.md.' },
]]);

/** Ignore only local release versions, never dependency versions or integrity. */
export function dependencyFingerprint(lock) {
  const normalized = structuredClone(lock);
  delete normalized.version;
  for (const [name, pkg] of Object.entries(normalized.packages ?? {})) {
    if (name === '' || /^packages\/[^/]+$/.test(name)) delete pkg.version;
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function approvalFor(advisory, now, approvals, severity, fingerprint) {
  const approval = approvals.get(advisory.url);
  if (!approval) return { approved: false, reason: `unapproved advisory ${advisory.url ?? advisory.source ?? 'unknown'}` };

  if (BLOCKING_SEVERITIES.has(severity) && (severity !== 'high' || !approval.allowHighSeverity || approval.package !== advisory.name || !approval.lockFingerprint))
    return { approved: false, reason: `${severity} severity is not explicitly approved for this dependency` };
  if (approval.lockFingerprint && approval.lockFingerprint !== fingerprint)
    return { approved: false, reason: 'approved production dependency graph changed; review the exception again' };

  const expiresAt = new Date(`${approval.expires}T00:00:00Z`);
  if (Number.isNaN(expiresAt.valueOf())) return { approved: false, reason: `invalid approval expiry ${approval.expires}` };
  if (now >= expiresAt) return { approved: false, reason: `approval expired ${approval.expires}` };

  return { approved: true, approval };
}

export function evaluateAudit(audit, options = {}) {
  const now = options.now ?? new Date();
  const approvals = options.approvals ?? APPROVED_ADVISORIES;
  const fingerprint = dependencyFingerprint(options.lock ?? JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')));
  const vulnerabilities = audit?.vulnerabilities ?? {};
  const memo = new Map();
  const visiting = new Set();

  function evaluatePackage(name) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return { approved: false, reasons: [`cyclic vulnerability chain at ${name}`], advisories: [] };

    const vulnerability = vulnerabilities[name];
    if (!vulnerability) return { approved: false, reasons: [`missing vulnerability detail for ${name}`], advisories: [] };
    if (vulnerability.severity === 'critical') {
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

      const result = approvalFor(via, now, approvals, via.severity ?? vulnerability.severity, fingerprint);
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

// Workspaces whose dependencies ship in the Core image, the MCP package or
// published sites. The documentation site is a build-time tool: its own
// dependencies are audited and reported, but do not block a release.
export const SHIPPED_WORKSPACES = ['@typeroll/portal', '@typeroll/shared', '@typeroll/mcp-server', '@typeroll/site-template'];
export const BUILD_ONLY_WORKSPACES = ['@typeroll/docs-site'];

export function auditArguments(workspaces, { includeRoot }) {
  return ['audit', '--json', ...(includeRoot ? ['--include-workspace-root'] : []), ...workspaces.map((name) => `--workspace=${name}`)];
}

function readAudit(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8' });
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
  return audit;
}

function run() {
  const evaluation = evaluateAudit(readAudit(auditArguments(SHIPPED_WORKSPACES, { includeRoot: true })));
  const buildOnly = evaluateAudit(readAudit(auditArguments(BUILD_ONLY_WORKSPACES, { includeRoot: false })));
  if (!buildOnly.ok) {
    console.warn(`Build-only dependencies (${BUILD_ONLY_WORKSPACES.join(', ')}) have advisories; they do not ship and do not block a release:`);
    for (const failure of buildOnly.failures) console.warn(`- ${failure}`);
  }

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
