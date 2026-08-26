# Testing

This document covers the local and automated test setup. Repository-wide
contributor rules are in [`AGENTS.md`](../AGENTS.md).

## Stack

| Tool       | Where             | What it does                                       |
| ---------- | ----------------- | -------------------------------------------------- |
| Vitest 4   | `portal`, `shared`| Unit + integration. Native ESM, jest-compatible API. |
| Playwright | `portal`          | E2E in headless Chromium against a real dev server. |
| GitHub Actions | `.github/workflows/test.yml` | Runs unit on every push/PR; e2e on top. |

## Running tests

```bash
# From repo root — all packages
npm test                         # unit + integration
npm run test:e2e                 # Playwright (auto-starts dev server on :4322)

# Watch mode while iterating in one package
npm run test:watch -w @typeroll/portal
npm run test:coverage -w @typeroll/portal     # v8 coverage report
```

Tests are isolated per file. The portal's `vitest.setup.ts` resets env vars and removes any tmp dirs the test created in `afterEach`. You don't need to clean up manually.

## Local test persona

When Firebase is not configured and `NODE_ENV` is not `production`, the portal
uses one deterministic local persona:

| Field | Value |
| --- | --- |
| User ID | `dev-user` |
| Email | `dev@typeroll.local` |
| Organization | `default` |
| Display name | `Dev User` |

No credential is required. `npm run dev:portal` creates this session through
the development auth fallback on every request. `npm run test:e2e` is the
idempotent creation and verification path: it resets a temporary fixture copy,
starts the portal without Firebase, signs in as this persona automatically,
and verifies authenticated editor, Extension, and Forms flows. Production
fails closed when Firebase is not configured, so the persona cannot be enabled
by a missing production credential.

## Authoring a unit test

```ts
// packages/portal/src/__tests__/lib/my-thing.test.ts
import { describe, it, expect } from 'vitest';
import { myThing } from '../../lib/my-thing';

describe('myThing', () => {
  it('does the thing', () => {
    expect(myThing('input')).toBe('expected');
  });
});
```

## Authoring an integration test that needs the datastore

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

describe('something with the store', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('reads what it wrote', async () => {
    makeTmpFixtures();           // creates a tmp dir, sets TYPEROLL_FIXTURES_DIR
    await resetDatastore();      // drops the singleton so the env var takes effect

    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site('o', 's'), { name: 'X' });
    const back = await getStore().getDoc(paths.site('o', 's'));
    expect(back?.name).toBe('X');
  });
});
```

Important: dynamic-import the modules under test *after* `resetDatastore()`. Top-of-file static imports load the datastore before the env var is set, defeating the helper.

## Authoring an e2e test

```ts
// packages/portal/tests/e2e/foo.spec.ts
import { test, expect } from '@playwright/test';

test('user can do the foo', async ({ page }) => {
  await page.goto('/app/sites/default');
  await page.getByRole('link', { name: /foo/i }).click();
  await expect(page).toHaveURL(/\/foo/);
});
```

E2E specs run against `http://127.0.0.1:4322`. The config in `playwright.config.ts` starts the dev server with empty `FIREBASE_SERVICE_ACCOUNT` / `ANTHROPIC_API_KEY`, so tests get the dev session (orgId='default') and a chat that returns its "not configured" message.

### E2E writes go to a throwaway fixtures copy

The suite drives the real editor, so it provokes real datastore writes — page saves, revision snapshots, created forms. Those used to land in `packages/site-template/fixtures/`, which is committed seed content, leaving `git status` dirty after every run. Gitignoring the paths wasn't available: `pages/home.json` is genuine seed, and the per-page `revisions/` folders hold snapshots the smoke build reads.

So the server gets its own copy. `tests/e2e/seed-fixtures.mjs` wipes and re-copies the fixtures tree into `$TMPDIR/typeroll-e2e-fixtures` on each start, and `webServer.env.TYPEROLL_FIXTURES_DIR` points the server at it — the same isolation `makeTmpFixtures()` gives unit tests, one level up. Two details worth keeping if you touch this:

- **Seeding runs inside the `webServer` command, not `globalSetup`.** Playwright starts `webServer` first, so a global-setup seed would arrive after the server had already booted against an empty directory.
- **The destination is a fixed name, not an `mkdtemp`.** Playwright re-evaluates the config in its worker processes, so a module-scope `mkdtempSync` would strand an orphan tree per worker; a stable path also means the `reuseExistingServer` case reuses a server already pointed at the right place.

The copy skips the runtime-only collections (`working_copies/`, `api_keys/`, `deploys/`, …) that a local dev session leaves behind, so a run tests against the same shape a fresh checkout has. `src/__tests__/lib/e2e-fixtures-isolation.test.ts` pins all of this.

## Coverage philosophy

We do not enforce a coverage threshold. The threshold-driven coverage chase tends to produce tests that exist to hit a number, not tests that catch bugs.

Instead, the rule is in `CONTRIBUTING.md`: when you change behavior, add the
narrowest test that proves the contract. If a meaningful automated test is not
available, document what remains unverified in the pull request.

## Adding tests when fixing a bug

The rule of thumb: write a test that reproduces the bug, watch it fail, then fix the bug. The bug is your evidence the test is meaningful — without it you might write a test that passes even on the broken code.

## What's not currently tested (known gaps)

- **`lib/anthropic.ts` (chat tool loop).** Requires mocking the Anthropic SDK. Worth doing when the tool surface changes shape.
- **`lib/workflows/*` (workflow engine and one-shot workflows).** Inline integration tests of individual steps are doable now.
- **Most `pages/api/*` routes.** Tested indirectly through `requireSiteAccess` coverage; route-level integration tests would catch shape regressions.
- **URL inventory network verification.** Unit coverage is strong, but provider-specific edge behavior still benefits from integration tests.
- **`render-preview.ts` + `site-template/components/SEOHead.astro`.** Easier to cover via e2e (one spec that loads a preview and asserts on the HTML).

Pick something off this list when you next touch the area — adding the test is the right time, not "later".
