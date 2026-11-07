import { defineConfig, devices } from '@playwright/test';

/**
 * Layout contract (tests/layout): builds a gallery publication offline and
 * checks it in Chromium. Needs no portal Worker, network or credentials.
 */
export default defineConfig({
  testDir: './tests/layout',
  timeout: 15 * 60_000,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 },
});
