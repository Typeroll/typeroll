/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit + integration tests live next to the code under __tests__/.
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    // Avoid running the Playwright spec files (separate runner).
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // The fixtures-backed datastore writes to a per-test temp dir, so we
    // can run tests in parallel safely.
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/pages/api/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts'],
      thresholds: {
        // Soft thresholds — we're starting from zero. Bump as coverage
        // grows. Failing CI on a 1% dip is more annoying than useful.
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
