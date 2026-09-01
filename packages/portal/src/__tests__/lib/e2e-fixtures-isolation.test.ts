// The e2e server must never use the committed fixtures tree as its
// datastore. It did until 2026-07: `npx playwright test` saved the home
// page through the real editor, so the SEO transform rewrote a tracked
// `pages/home.json`, dropped revision snapshots beside it, and created a
// `forms/` collection — `git status` was dirty after every run.
//
// Gitignoring the paths isn't an option, because the same directories
// hold seed content (`pages/about/revisions/*.json` is committed and the
// smoke build reads it). Isolation is the fix, and these assertions pin
// the three pieces that make it work.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PORTAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TRACKED_FIXTURES = path.resolve(PORTAL_DIR, '..', 'site-template', 'fixtures');

async function loadPlaywrightConfig() {
  const mod = await import('../../../playwright.config.js');
  return mod.default as {
    webServer?: { command?: string; env?: Record<string, string> };
  };
}

describe('e2e fixtures isolation', () => {
  it('points the test server at a fixtures dir outside the tracked tree', async () => {
    const config = await loadPlaywrightConfig();
    const dir = config.webServer?.env?.TYPEROLL_FIXTURES_DIR;

    expect(dir, 'webServer.env must set TYPEROLL_FIXTURES_DIR').toBeTruthy();
    // Without the override the resolver searches upward for a directory
    // containing `organizations/` and lands on the committed tree.
    expect(path.resolve(dir!).startsWith(TRACKED_FIXTURES)).toBe(false);
  });

  it('seeds that dir before starting the server', async () => {
    const config = await loadPlaywrightConfig();
    const command = config.webServer?.command ?? '';
    const dir = config.webServer?.env?.TYPEROLL_FIXTURES_DIR ?? '';

    // Seeding has to run inside the server command: Playwright starts
    // `webServer` before `globalSetup`, so a global-setup seed would land
    // after the server has already booted against an empty directory.
    expect(command).toContain(dir);
    expect(command).toMatch(/seed-fixtures\.mjs.*&&.*npm run build.*&&.*node \.\/dist\/server\/entry\.mjs/);
  });

  it('seed-fixtures.mjs produces a store the resolver accepts, without runtime state', () => {
    const dest = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tr-e2e-seed-test-'));
    try {
      execFileSync('node', [path.join(PORTAL_DIR, 'tests', 'e2e', 'seed-fixtures.mjs'), dest], {
        stdio: 'pipe',
      });

      // The `organizations/` marker is what makes the fixtures backend
      // treat a directory as a real store rather than searching upward.
      expect(fs.existsSync(path.join(dest, 'organizations'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'organizations', 'default', 'sites', 'default'))).toBe(true);

      // A developer's local portal session leaves runtime collections in
      // the fixtures tree (they're gitignored, not absent). Copying them
      // would let one machine's leftover draft change what the suite
      // sees; a fresh checkout has none, and that's what we test against.
      const versionDir = path.join(
        dest,
        'organizations/default/sites/default/versions/main',
      );
      expect(fs.existsSync(path.join(versionDir, 'working_copies'))).toBe(false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('refuses a destination outside the temp roots instead of wiping it', () => {
    // The script's first act is `rmSync(dest, { recursive: true, force: true })`
    // on a bare argv. playwright.config.ts always passes a temp path, but the
    // script is runnable by hand, and `node seed-fixtures.mjs .` would take
    // the working tree with it. Unrecoverable, so it is worth a guard and a
    // test that drives the actual dangerous invocations.
    const script = path.join(PORTAL_DIR, 'tests', 'e2e', 'seed-fixtures.mjs');
    const canary = path.join(PORTAL_DIR, 'package.json');

    for (const dangerous of ['.', PORTAL_DIR, path.resolve(PORTAL_DIR, '..', '..'), '/']) {
      let failed = false;
      try {
        execFileSync('node', [script, dangerous], { stdio: 'pipe' });
      } catch {
        failed = true;
      }
      expect(failed, `should refuse ${dangerous}`).toBe(true);
    }

    // And the refusal is real, not merely a non-zero exit after the damage.
    expect(fs.existsSync(canary)).toBe(true);
  });

  it('accepts the path playwright.config.ts actually passes', async () => {
    // The guard must not be so strict that it rejects the real caller — a
    // seeding step that always fails would leave the suite pointed at an empty
    // directory, which fails obscurely rather than loudly.
    const config = await loadPlaywrightConfig();
    const dest = config.webServer?.env?.TYPEROLL_FIXTURES_DIR;
    expect(dest).toBeTruthy();
    execFileSync('node', [path.join(PORTAL_DIR, 'tests', 'e2e', 'seed-fixtures.mjs'), dest!], {
      stdio: 'pipe',
    });
    expect(fs.existsSync(path.join(dest!, 'organizations'))).toBe(true);
    fs.rmSync(dest!, { recursive: true, force: true });
  });

  it('leaves the tracked fixtures tree untouched when it seeds', () => {
    const before = execFileSync('git', ['status', '--short', '--', TRACKED_FIXTURES], {
      cwd: PORTAL_DIR,
      encoding: 'utf8',
    });

    const dest = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tr-e2e-seed-test-'));
    try {
      execFileSync('node', [path.join(PORTAL_DIR, 'tests', 'e2e', 'seed-fixtures.mjs'), dest], {
        stdio: 'pipe',
      });
      const after = execFileSync('git', ['status', '--short', '--', TRACKED_FIXTURES], {
        cwd: PORTAL_DIR,
        encoding: 'utf8',
      });
      expect(after).toBe(before);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
