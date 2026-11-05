// The local Playwright run uses the built Worker in `wrangler dev --local`
// (tests/e2e/start-worker.mjs) with a fresh store per run, seeded from the
// committed fixtures without writing to them. These assertions pin the
// pieces that keep that run local-only and isolated.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLocalE2EMode } from '../../lib/local-e2e';
import { localFixtureDocuments, writeFixtureTree, FIXTURES_SOURCE } from '../../../tests/e2e/seed-store.mjs';

const PORTAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const START = path.join(PORTAL_DIR, 'tests', 'e2e', 'start-worker.mjs');

async function loadPlaywrightConfig() {
  const mod = await import('../../../playwright.config.js');
  return mod.default as { webServer?: { command?: string; env?: Record<string, string> }; globalSetup?: string };
}

describe('local E2E Worker', () => {
  it('runs the built Worker in local E2E mode without accounts', async () => {
    const config = await loadPlaywrightConfig();
    expect(config.webServer?.command).toMatch(/node \.\/tests\/e2e\/start-worker\.mjs \d+/);
    expect(config.globalSetup).toMatch(/global-setup\.ts$/);
    const vars = JSON.parse(config.webServer?.env?.TYPEROLL_E2E_WORKER_VARS ?? '{}') as Record<string, string>;
    expect(isLocalE2EMode(vars)).toBe(true);
    expect(vars.AUTH_SECRET).toBeUndefined();
    expect(vars.TYPEROLL_E2E_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('refuses to start a Worker whose variables do not describe local E2E mode', () => {
    for (const vars of [
      {},
      { TYPEROLL_LOCAL_E2E: 'allow', STORE_JURISDICTION: 'eu' },
      { TYPEROLL_LOCAL_E2E: 'allow', STORE_JURISDICTION: 'none', AUTH_SECRET: 'real-auth-secret-0123456789abcdef-0123456789' },
    ]) {
      const result = spawnSync(process.execPath, [START, '4399'], {
        env: { ...process.env, TYPEROLL_E2E_WORKER_VARS: JSON.stringify(vars), TYPEROLL_E2E_SKIP_BUILD: 'true' },
        encoding: 'utf8', timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/refusing to start|must be a JSON object/);
    }
  });

  it('seeds the committed fixtures and the personas, without runtime state', () => {
    const documents = localFixtureDocuments() as Map<string, Record<string, unknown>>;
    expect(documents.has('organizations/default')).toBe(true);
    expect(documents.has('organizations/default/sites/default')).toBe(true);
    expect(documents.has('organizations/default/sites/default/versions/main/pages/home')).toBe(true);
    expect(documents.has('organizations/e2e-core/sites/e2e-core-site')).toBe(true);
    expect(documents.has('organizations/e2e-core/members/typeroll-e2e-owner')).toBe(true);
    for (const path of documents.keys()) {
      expect(path.split('/').length % 2, path).toBe(0);
      expect(path).not.toMatch(/\/(working_copies|api_keys|api_audit|deploys|chat_messages)\//);
    }
  });

  it('never writes to the committed fixtures tree', () => {
    const before = execFileSync('git', ['status', '--short', '--', FIXTURES_SOURCE], { cwd: PORTAL_DIR, encoding: 'utf8' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-tree-'));
    try {
      writeFixtureTree(dest, localFixtureDocuments());
      expect(fs.existsSync(path.join(dest, 'organizations/default/sites/default.json'))).toBe(true);
      expect(() => writeFixtureTree(dest, new Map([['../escape', {}]]))).toThrow(/escapes/);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    expect(execFileSync('git', ['status', '--short', '--', FIXTURES_SOURCE], { cwd: PORTAL_DIR, encoding: 'utf8' })).toBe(before);
  });
});
