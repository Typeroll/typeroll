import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Discover through Playwright itself: configuration mistakes must not silently
// remove a persona, browser or mutation contract from the release gate.
test('remote qualification runs server contracts once and browser contracts in every project', () => {
  const report = JSON.parse(execFileSync(process.execPath, [
    'node_modules/@playwright/test/cli.js', 'test', '--config', 'packages/portal/playwright.config.ts',
    'target-contract.spec.ts', '--list', '--reporter=json',
  ], { encoding: 'utf8', env: { ...process.env,
    TYPEROLL_E2E_TARGET: 'cloud', TYPEROLL_E2E_FULL_BROWSERS: 'true',
    TYPEROLL_E2E_PORTAL_URL: 'https://portal.example.invalid', TYPEROLL_E2E_FORMS_URL: 'https://forms.example.invalid',
    TYPEROLL_E2E_EXPECTED_DIGEST: 'sha256:' + 'a'.repeat(64), TYPEROLL_E2E_FIREBASE_API_KEY: 'public-test-key',
  } }));
  const byTitle = new Map();
  for (const spec of report.suites.flatMap(suite => suite.specs)) {
    const previous = byTitle.get(spec.title);
    if (previous) previous.tests.push(...spec.tests);
    else byTitle.set(spec.title, { ...spec, tests: [...spec.tests] });
  }
  const specs = [...byTitle.values()];
  assert.equal(specs.length, 12, 'all original contracts remain');
  for (const spec of specs) {
    const projects = spec.tests.map(item => item.projectName);
    assert.deepEqual(projects, spec.tags.includes('server') ? ['chromium-desktop'] :
      ['chromium-desktop', 'chromium-mobile-390', 'chromium-mobile-320', 'firefox-desktop', 'webkit-desktop']);
  }
  assert.equal(specs.filter(spec => spec.tags.includes('server')).length, 10);
  assert.equal(specs.reduce((sum, spec) => sum + spec.tests.length, 0), 20);
});
