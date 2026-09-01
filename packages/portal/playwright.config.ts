import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for portal e2e. Runs against a real dev server bound
 * to port 4322 (one above the default dev port so concurrent local work
 * doesn't conflict). The server is started/stopped per `webServer` config
 * — slow but isolated.
 */

/**
 * Where the e2e dev server keeps its datastore.
 *
 * Without this the server writes to `packages/site-template/fixtures/`,
 * which is committed seed content — so driving the real editor left the
 * working tree dirty (a rewritten `pages/home.json`, fresh
 * `pages/*\/revisions/*.json`, a `forms/` collection) after every run.
 * Ignoring those paths isn't available to us: the same directories hold
 * seed content the smoke build asserts on.
 *
 * The path is a fixed name rather than an `mkdtemp` for two reasons.
 * Playwright re-evaluates this config in its worker processes, so a
 * module-scope `mkdtempSync` would strand one orphan tree per worker.
 * And `reuseExistingServer` below means a leftover server from an earlier
 * run may serve this one — with a stable path that server is already
 * pointed at the right place. Freshness comes from `seed-fixtures.mjs`
 * wiping and re-copying on each start, not from a unique name.
 */
const E2E_FIXTURES_DIR = path.join(os.tmpdir(), 'typeroll-e2e-fixtures');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // datastore writes are global per fixtures dir
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4322',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // The portal's `dev` script no longer hardcodes a port — astro's
    // default is 4321, and this trailing `--port 4322` is what makes
    // the e2e server bind to a different port than local dev. (Earlier
    // the dev script had `--port 4321` baked in; astro takes the FIRST
    // `--port` arg, not the last, so this override was silently ignored
    // and the e2e webServer ran on 4321 while Playwright waited on 4322
    // until timeout.)
    // Seeding runs as part of the server command, not in `globalSetup`:
    // Playwright starts `webServer` before global setup, so the fixtures
    // have to exist by the time this line runs.
    command: `node ./tests/e2e/seed-fixtures.mjs "${E2E_FIXTURES_DIR}" && npm run dev -- --port 4322`,
    url: 'http://127.0.0.1:4322',
    reuseExistingServer: !process.env.CI,
    // Cold-start on the GitHub runner has gradually crept past 4 minutes
    // after the dep graph grew (dnd-kit, jszip, htmlparser2, the block-
    // editor's hundreds of icon imports) and the Node 22 bump in 2026-05.
    // Bumping to 6 min keeps headroom for the dev-server's optimizeDeps
    // pass. If we ever blow past that, the right fix is to switch the
    // webServer to `astro preview` (a one-time prod build, no per-test
    // optimizeDeps) — but dev mode is cheaper to keep when it fits the
    // budget.
    timeout: 360_000,
    // Surface dev-server output to the parent terminal so CI logs show
    // why startup is slow / failing. Without this, Playwright silently
    // swallows everything astro/vite print, leaving us guessing on a
    // bare "Timed out" message after the deadline. The volume is small —
    // a few dozen lines of optimizeDeps + the "Local: http://..."
    // readiness line.
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // E2E never touches Firebase / R2 / Anthropic — it runs against the
      // local fixtures backend, which is what the bundled sample content
      // assumes.
      FIREBASE_SERVICE_ACCOUNT: '',
      ANTHROPIC_API_KEY: '',
      FORMS_HMAC_SECRET: 'e2e-only-form-signing-secret-32-characters-minimum',
      DEPLOY_QUEUE: 'in_process',
      // Every write the suite provokes — page saves, revision snapshots,
      // created forms — lands in the throwaway copy seeded above instead
      // of the committed fixtures tree.
      TYPEROLL_FIXTURES_DIR: E2E_FIXTURES_DIR,
    },
  },
});
