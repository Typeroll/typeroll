// Test-wide setup. Forces the datastore + envs into a predictable state
// before any module under test loads.

import { afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpDir } from './src/__tests__/helpers/tmp-fixtures';

// Ensure the auto-loaded .env doesn't bleed real keys into tests.
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.R2_ACCOUNT_ID;
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_IMAGE_ORIGIN;
process.env.TYPEROLL_SCHEDULER = 'off';
process.env.FORMS_HMAC_SECRET = 'test-hmac-secret-please-change-for-real-use-32+chars';
// Pin TYPEROLL_FIXTURES_DIR per-test via the helper; no global override.

// The image check after a publication reads the live site. Tests never reach
// the network: it reports nothing unless a test sets a result.
vi.mock('./src/lib/publishing/media-serving', async original => ({
  ...await original<typeof import('./src/lib/publishing/media-serving')>(),
  checkLiveMedia: vi.fn(async () => ({ status: 'inconclusive', checked: 0, failing: [] })),
}));

afterEach(() => {
  // Helper-managed temp dirs get cleaned up after each test that opts in.
  // This catch-all is just a safety net.
  for (const dir of tmpDir.allCreated()) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDir.reset();
});
