# Testing

This document covers the local and automated test setup. Repository-wide
contributor rules are in [`AGENTS.md`](../AGENTS.md).

## Stack

| Tool       | Where             | What it does                                       |
| ---------- | ----------------- | -------------------------------------------------- |
| Vitest 4   | `portal`, `shared`| Unit + integration. Native ESM, jest-compatible API. |
| Playwright | `portal`          | E2E in headless Chromium against a built server artifact. |
| GitHub Actions | `.github/workflows/test.yml` | Runs unit on every push/PR; e2e on top. |

## Running tests

```bash
# From repo root — all packages
npm test                         # unit + integration
npm run test:e2e                 # Playwright (builds and starts the server on :4322)

# Watch mode while iterating in one package
npm run test:watch -w @typeroll/portal
npm run test:coverage -w @typeroll/portal     # v8 coverage report
```

Tests are isolated per file. The portal's `vitest.setup.ts` resets env vars and removes any tmp dirs the test created in `afterEach`. You don't need to clean up manually.

## Test personas

The complete persona contract lives in
[`config/e2e-personas.json`](../config/e2e-personas.json). Core owns and seeds
the identities needed to verify CMS authorization:

| Persona | Expected site permission |
| --- | --- |
| `owner` | admin |
| `editor` | write |
| `viewer` | read through a cross-organization share |
| `outsider` | none |
| `pending` | authenticated without organization access |

The manifest also reserves `operator`, `app_entitled`, and `app_unentitled` for
Typeroll Cloud. Core never seeds or interprets those private control-plane and
Apps entitlements.

Local Playwright runs need no credentials. The seeder creates the five Core
personas in a throwaway fixture copy and the test server exposes a signed,
local-only session exchange. That exchange requires a per-process HMAC secret,
is available only with `NODE_ENV=test`, is unavailable when Firebase is
configured, and fails closed in every other process mode.
The ordinary `dev-user` fallback remains available for older local tests.

Remote `self_host` and `cloud` targets use stable Firebase Auth users and real
password login. Every email and password is injected through the environment;
passwords must contain at least 32 characters and must be unique per persona.
Never commit a credential file. If `--env-file` is used, the CLI refuses any
mode other than `0600`.

```bash
# Idempotent local seed and verification
npm run e2e:personas -- seed --fixtures-dir /tmp/typeroll-e2e
npm run e2e:personas -- verify --fixtures-dir /tmp/typeroll-e2e

# Remote mutation requires the exact Firebase project ID as confirmation
npm run e2e:personas -- seed --environment self_host \
  --env-file /private/path/self-host-e2e.env \
  --confirm-project typeroll-self-host-e2e

# Verification is read-only and does not require mutation confirmation
npm run e2e:personas -- verify --environment self_host \
  --env-file /private/path/self-host-e2e.env
```

Remote environments require `FIREBASE_SERVICE_ACCOUNT`,
`TYPEROLL_E2E_FIREBASE_API_KEY`, and the email/password variables named by the
manifest. Service accounts and passwords belong in the shared credential store;
only the public Firebase API key may be stored as ordinary test configuration.
These identities are permanent sentinels, marked with `is_test_account` and a
stable `e2e_persona` claim. Automated cleanup must not delete them. Retire only
the exact manifest UIDs when the whole target environment is decommissioned,
with the same explicit project confirmation used for seeding.

## E2E targets

`TYPEROLL_E2E_TARGET` selects `local` (default), `self_host`, or `cloud`.
Remote targets additionally require:

| Variable | Contract |
| --- | --- |
| `TYPEROLL_E2E_PORTAL_URL` | HTTPS portal origin |
| `TYPEROLL_E2E_FORMS_URL` | Separate HTTPS Forms origin |
| `TYPEROLL_E2E_FIREBASE_API_KEY` | Public Firebase Web API key |
| `TYPEROLL_E2E_EXPECTED_DIGEST` | Exact `sha256:…` image digest |

Run `npm run e2e:target:check` before browser tests. It checks portal liveness,
portal and Forms readiness, and rejects an image digest different from the
expected immutable release. `npm run test:e2e -w @typeroll/portal` then runs
the remote target contract on desktop, 390 px, and 320 px Chromium profiles.
The contract verifies real password login/logout and non-mutating read, write,
and admin guards for every Core persona.

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

Local E2E specs run against `http://127.0.0.1:4322`. The config in
`playwright.config.ts` builds the SSR server artifact and starts it with empty
`FIREBASE_SERVICE_ACCOUNT` / `ANTHROPIC_API_KEY`; the default development
session and the isolated E2E persona exchange are both available.

### E2E writes go to a throwaway fixtures copy

The suite drives the real editor, so it provokes real datastore writes — page saves, revision snapshots, created forms. Those used to land in `packages/site-template/fixtures/`, which is committed seed content, leaving `git status` dirty after every run. Gitignoring the paths wasn't available: `pages/home.json` is genuine seed, and the per-page `revisions/` folders hold snapshots the smoke build reads.

So the server gets its own copy. `tests/e2e/seed-fixtures.mjs` wipes and re-copies the fixtures tree into `$TMPDIR/typeroll-e2e-fixtures` on each start, and `webServer.env.TYPEROLL_FIXTURES_DIR` points the server at it — the same isolation `makeTmpFixtures()` gives unit tests, one level up. Two details worth keeping if you touch this:

- **Seeding runs inside the `webServer` command, not `globalSetup`.** Playwright starts `webServer` first, so a global-setup seed would arrive after the server had already booted against an empty directory.
- **The destination is a fixed name, not an `mkdtemp`.** Playwright re-evaluates the config in its worker processes, so a module-scope `mkdtempSync` would strand an orphan tree per worker.

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
