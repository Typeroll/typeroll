import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { resolveE2ETarget } from '../../scripts/lib/e2e-target.mjs';

/**
 * Playwright config for portal e2e. Local runs build the real server artifact
 * and bind it to port 4322 (one above the default dev port so concurrent local
 * work doesn't conflict). The server is started/stopped per `webServer` config.
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
 * Freshness comes from `seed-fixtures.mjs` wiping and re-copying on each start.
 */
const E2E_FIXTURES_DIR = path.join(os.tmpdir(), 'typeroll-e2e-fixtures');
const LOCAL_E2E_AUTH_SECRET = 'local-e2e-auth-secret-at-least-32-characters';
const target = resolveE2ETarget(process.env);
const fullRemoteBrowsers = process.env.TYPEROLL_E2E_FULL_BROWSERS === 'true';
if (!target.isRemote && !process.env.TYPEROLL_E2E_AUTH_SECRET) {
  process.env.TYPEROLL_E2E_AUTH_SECRET = LOCAL_E2E_AUTH_SECRET;
}

const webServer = target.isRemote ? undefined : {
  command: `node ./tests/e2e/seed-fixtures.mjs "${E2E_FIXTURES_DIR}" && npm run build && node ./dist/server/entry.mjs`,
  url: target.portalUrl,
  reuseExistingServer: false,
  timeout: 360_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '4322',
    FIREBASE_SERVICE_ACCOUNT: '',
    ANTHROPIC_API_KEY: '',
    FORMS_HMAC_SECRET: 'e2e-only-form-signing-secret-32-characters-minimum',
    DEPLOY_QUEUE: 'in_process',
    TYPEROLL_FIXTURES_DIR: E2E_FIXTURES_DIR,
    TYPEROLL_E2E_AUTH_SECRET: process.env.TYPEROLL_E2E_AUTH_SECRET,
  },
};

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: target.isRemote ? /target-contract\.spec\.ts/ : undefined,
  fullyParallel: false, // datastore writes are global per fixtures dir
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: target.portalUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: target.isRemote ? [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile-390', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    { name: 'chromium-mobile-320', use: { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } } },
    ...(fullRemoteBrowsers ? [
      { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    ] : []),
  ] : [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer,
});
