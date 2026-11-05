import { defineConfig, devices } from '@playwright/test';
import { resolveE2ETarget } from '../../scripts/lib/e2e-target.mjs';

/**
 * Playwright config for portal e2e. Local runs build the portal Worker and run
 * the built bundle in `wrangler dev --local` on port 4322 (one above the
 * default dev port so concurrent local work doesn't conflict); see
 * tests/e2e/start-worker.mjs. Every run starts from an empty Durable Object
 * store in a fresh temporary directory, which tests/e2e/global-setup.ts seeds
 * with the fixture content through the local-E2E-only seeding route.
 */

const LOCAL_E2E_AUTH_SECRET = 'local-e2e-auth-secret-at-least-32-characters';
const target = resolveE2ETarget(process.env);
const fullRemoteBrowsers = process.env.TYPEROLL_E2E_FULL_BROWSERS === 'true';
if (!target.isRemote && !process.env.TYPEROLL_E2E_AUTH_SECRET) {
  process.env.TYPEROLL_E2E_AUTH_SECRET = LOCAL_E2E_AUTH_SECRET;
}

/**
 * The Worker's variables for local E2E mode (src/lib/local-e2e.ts). Written to
 * a per-run `.dev.vars`; there is deliberately no AUTH_SECRET, so the signed
 * persona exchange and the development user are available.
 */
export const LOCAL_WORKER_VARS: Record<string, string> = {
  TYPEROLL_LOCAL_E2E: 'allow',
  // Local workerd has no Durable Object jurisdictions.
  STORE_JURISDICTION: 'none',
  PORTAL_PUBLIC_URL: target.portalUrl,
  TYPEROLL_ORGANIZATION_ACCESS_POLICY: JSON.stringify({ initial_days: 30, read_days: 90, own_smtp: true, contact_url: 'https://example.invalid/trial' }),
  // Organization AI keys are stored encrypted. The Anthropic key check goes
  // to the stub that organization-ai.spec.ts serves on this port; no other
  // spec reaches Anthropic, and there is no server-wide AI key.
  INTEGRATIONS_SECRET_KEY: 'e2e-only-integrations-secret-key-at-least-32-characters',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:4329',
  FORMS_HMAC_SECRET: 'e2e-only-form-signing-secret-32-characters-minimum',
  MCP_OAUTH_SIGNING_KEY: 'e2e-only-mcp-signing-secret-at-least-32-characters',
  PREVIEW_HMAC_SECRET: 'e2e-only-preview-signing-secret-32-characters-minimum',
  ACCOUNT_EMAIL: 'log',
  TYPEROLL_E2E_AUTH_SECRET: process.env.TYPEROLL_E2E_AUTH_SECRET ?? '',
};

const webServer = target.isRemote ? undefined : {
  command: `node ./tests/e2e/start-worker.mjs ${new URL(target.portalUrl).port || '4322'}`,
  url: `${target.portalUrl}/api/healthz`,
  // Opt-in for iterating on specs against a server started by hand with
  // start-worker.mjs; a normal run always starts a fresh Worker and store.
  reuseExistingServer: process.env.TYPEROLL_E2E_REUSE_SERVER === 'true',
  timeout: 360_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: { TYPEROLL_E2E_WORKER_VARS: JSON.stringify(LOCAL_WORKER_VARS) },
  // Playwright SIGKILLs the server by default; SIGTERM lets start-worker.mjs
  // stop wrangler and remove the run's state directory and `.dev.vars`.
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
};

const RESERVED_NAMES_NOT_FOUND = '--host-resolver-rules=MAP *.test ~NOTFOUND, MAP *.invalid ~NOTFOUND, MAP *.example ~NOTFOUND, MAP example.com ~NOTFOUND, MAP *.example.com ~NOTFOUND';

/** Specs that also run in Firefox and WebKit (`npm run test:e2e:install` installs both). */
const CROSS_ENGINE_TESTS = /(?:editor-draft-recovery|forms-multistep-validation|address-field-parity|media-and-carousel|mobile-site-switcher|fluid-typography|contextual-spacing|design-tokens|post-card-hit-area|migration-design|link-role-hover|preview-links)\.spec\.ts/;
const CROSS_ENGINE_SPECS = [
  { name: 'firefox', device: 'Desktop Firefox' },
  { name: 'webkit', device: 'Desktop Safari' },
] as const;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: target.isRemote ? /target-contract\.spec\.ts/ : undefined,
  fullyParallel: false, // the specs share one store
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
  // Server contracts use HTTP/session APIs and run once per target. Keep real
  // login/logout and viewport assertions in every browser/viewport project.
  projects: target.isRemote ? [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile-390', grepInvert: /@server/, use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    { name: 'chromium-mobile-320', grepInvert: /@server/, use: { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } } },
    ...(fullRemoteBrowsers ? [
      { name: 'firefox-desktop', grepInvert: /@server/, use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit-desktop', grepInvert: /@server/, use: { ...devices['Desktop Safari'] } },
    ] : []),
  ] : [
    // Reserved names (RFC 2606/6761) never resolve. Answer them at once instead
    // of asking the machine's resolver, which may hang: specs redirect to such
    // hosts (OAuth clients) and must stay offline and deterministic.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: [RESERVED_NAMES_NOT_FOUND] } } },
    // Browser-engine-specific behaviour (native form validation) runs in
    // every engine; the rest of the suite stays Chromium-only.
    ...CROSS_ENGINE_SPECS.map(({ name, device }) => ({ name, testMatch: CROSS_ENGINE_TESTS, use: { ...devices[device] } })),
  ],
  webServer,
  globalSetup: target.isRemote ? undefined : './tests/e2e/global-setup.ts',
});
