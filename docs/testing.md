# Testing

This document covers the local and automated test setup. Repository-wide
contributor rules are in [`AGENTS.md`](../AGENTS.md).

## Stack

| Tool       | Where             | What it does                                       |
| ---------- | ----------------- | -------------------------------------------------- |
| Vitest 4   | `portal`, `shared`| Unit + integration. Native ESM, jest-compatible API. |
| Playwright | `portal`          | E2E in Chromium, Firefox and WebKit against the built Worker in `wrangler dev --local`. |
| GitHub Actions | `.github/workflows/test.yml` | Runs unit on every push/PR; e2e on top. |

## Running tests

```bash
# From repo root — all packages
npm test                         # unit + integration
npm run test:e2e                 # Playwright (builds the Worker and runs it on :4322)

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

Local Playwright runs need no credentials. Global setup seeds the five Core
personas with the fixture content, and the local Worker exposes a signed,
local-only session exchange. That exchange requires a per-run HMAC secret and
local E2E mode (`src/lib/local-e2e.ts`): the explicit switch
`TYPEROLL_LOCAL_E2E=allow`, `STORE_JURISDICTION=none` (only local workerd has
no jurisdiction), a loopback `PORTAL_PUBLIC_URL` and no `AUTH_SECRET`. It does
not depend on `NODE_ENV`, which the Worker build fixes to `production`, and it
fails closed whenever any condition is missing. The ordinary `dev-user`
fallback is available in the same mode for older local tests.

Remote `self_host` and `cloud` targets use stable portal accounts, real
password login, and one site-scoped E2E API key. Every credential is injected
through the environment; passwords must contain at least 32 characters and
must be unique per persona. `TYPEROLL_E2E_API_KEY` must use the ordinary
`typeroll_live_<prefix>_<secret>` shape.

Remote seeding goes through the target's persona endpoint, never through
direct database access. `TYPEROLL_E2E_SEED_URL` names it (HTTPS, no
credentials or query) and `TYPEROLL_E2E_SEED_TOKEN` (at least 32 characters)
authenticates the request. On Typeroll Cloud staging the endpoint is the
operator's token-gated `/api/e2e-personas` route, which calls the portal's
internal operator API (`seedE2EPersonas` / `inspectE2EPersonas`); the portal
accepts seeding only with `TYPEROLL_E2E_PERSONA_SEEDING=allow` and only inside
the E2E namespace. The seeder writes the personas' accounts, memberships, the
fixture site and its two namespaced key documents, and never prints the token.
Never commit a credential file. If `--env-file` is used, the CLI refuses any
mode other than `0600`.

The seeded site is deliberately domain-neutral, uses the stable
`e2e-core-site` slug and has no publishing: the browser contracts never publish
it. Journeys that publish (`e2e:agent`, `e2e:fallback-indexing`) run against a
separate site with working customer publishing, named by
`TYPEROLL_E2E_JOURNEY_SITE`.

```bash
# Idempotent local seed and verification
npm run e2e:personas -- seed --fixtures-dir /tmp/typeroll-e2e
npm run e2e:personas -- verify --fixtures-dir /tmp/typeroll-e2e

# Remote mutation requires the exact seeding endpoint host as confirmation
npm run e2e:personas -- seed --environment cloud \
  --env-file /private/path/cloud-staging-e2e.env \
  --confirm-target operator-staging.example.com

# Verification is read-only and does not require mutation confirmation
npm run e2e:personas -- verify --environment cloud \
  --env-file /private/path/cloud-staging-e2e.env
```

Remote persona administration needs `TYPEROLL_E2E_SEED_URL`,
`TYPEROLL_E2E_SEED_TOKEN` and the email/password variables named by the
manifest. Remote E2E also requires `TYPEROLL_E2E_API_KEY`. The seed token, API
keys and passwords belong in the shared credential store; only URLs may be
stored as ordinary test configuration.
These identities are permanent sentinels, marked with `is_test_account` and a
stable `e2e_persona` claim. Automated cleanup must not delete them. Retire only
the exact manifest UIDs when the whole target environment is decommissioned,
with the same explicit target confirmation used for seeding.

## E2E targets

`TYPEROLL_E2E_TARGET` selects `local` (default), `self_host`, or `cloud`.
Remote targets additionally require:

| Variable | Contract |
| --- | --- |
| `TYPEROLL_E2E_PORTAL_URL` | HTTPS portal origin |
| `TYPEROLL_E2E_FORMS_URL` | Separate HTTPS Forms origin |
| `TYPEROLL_E2E_EXPECTED_DIGEST` | Exact `sha256:…` Worker bundle digest |
| `TYPEROLL_E2E_API_KEY` | Secret site-scoped key for the permanent E2E fixture |
| `TYPEROLL_E2E_FALLBACK_ORIGIN` | Exact platform fallback origin expected by the Cloud-only indexing journey |

Run `npm run e2e:target:check` before browser tests. It checks portal liveness,
portal and Forms readiness, and rejects a bundle digest different from the
expected immutable release. `npm run test:e2e -w @typeroll/portal` then runs
the remote target contract on desktop, 390 px, and 320 px Chromium profiles.
Set `TYPEROLL_E2E_FULL_BROWSERS=true` for the release/nightly expansion to
desktop Firefox and WebKit. The contract verifies real password login/logout;
non-mutating read, write, and admin guards for every Core persona; public REST
reads for pages, Apps, and Extensions; authenticated hosted-MCP initialize,
tool discovery, and a real `get_site_capabilities` call; Extension issuer/JWKS;
and horizontal-overflow screenshots of the authenticated Core shell.

The Core `apps` check covers the self-hosted module registry and its secret
masking boundary. Commercial Typeroll Apps purchase, entitlement, lease, and
Cloud-backend behavior are private Cloud product journeys and must be tested in
the Cloud repository; a successful Core module listing is not evidence that
those journeys work.

After a candidate with recursive branch cleanup is deployed, run the bounded
mutable agent contract once per target. It needs a site with working customer
publishing: name it in `TYPEROLL_E2E_JOURNEY_SITE`, pass a site API key for it in
`TYPEROLL_E2E_JOURNEY_API_KEY`, and confirm the same site:

```bash
npm run e2e:agent -- --confirm-site <site-id>
```

It uses hosted MCP to create a run-namespaced branch, save and read back one
branch-only page change, open the signed preview, complete a dry-run deploy,
and recursively delete the branch in a `finally` cleanup. It never merges or
deploys to production. Keep this separate from the viewport matrix so a single
qualification creates only one build job per target.

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

Local E2E specs run against `http://127.0.0.1:4322` (`TYPEROLL_E2E_PORTAL_URL`
moves it to another loopback port). The `webServer` in `playwright.config.ts`
runs `tests/e2e/start-worker.mjs`, which builds the portal and runs the built
bundle (`dist/server/wrangler.json`) in `wrangler dev --local`: the same Worker,
Durable Object store and scheduler that deploy, in local E2E mode without
`AUTH_SECRET`. The default development session and the isolated E2E persona
exchange are both available.

### Each run gets its own store

The suite drives the real editor, so it provokes real writes — page saves,
revision snapshots, created forms. The Worker keeps them in Durable Objects
under a fresh temporary directory per run, so nothing reaches the committed
`packages/site-template/fixtures/` tree:

- `start-worker.mjs` creates the directory (not the config: Playwright
  evaluates the config again in every worker process), writes the Worker's
  `.dev.vars` there with mode `0600` (`--env-file`, so a developer's own
  `.dev.vars` is never read), persists the store there and removes it when the
  server stops. It refuses variables that do not describe local E2E mode.
- `tests/e2e/global-setup.ts` runs after the server is up and seeds the
  committed fixtures (minus runtime-only collections such as `working_copies/`,
  `api_keys/` and `deploys/`), the `default` organization and the Core personas
  through `POST /api/internal/e2e-store`.
- Specs arrange and inspect documents through `tests/e2e/helpers/store.ts`
  (`e2eStore.get/set/delete/deleteTree/list`) on the same route. Specs that
  also build a static site write a temporary JSON fixtures tree for that build
  with `writeFixtureTree` from `tests/e2e/seed-store.mjs`.

The route answers 404 unless local E2E mode is on, the request reached a
loopback host and it carries the per-run E2E secret.
`src/__tests__/lib/e2e-local-worker.test.ts` and `e2e-store.test.ts` pin this.

To iterate on specs, start the server once by hand and reuse it:

```bash
cd packages/portal
TYPEROLL_E2E_WORKER_VARS='…' node tests/e2e/start-worker.mjs 4322   # vars as in playwright.config.ts
TYPEROLL_E2E_REUSE_SERVER=true npx playwright test some.spec.ts --project=chromium
```

`TYPEROLL_E2E_SKIP_BUILD=true` skips the build when `dist/` is current.

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

## Permanent-target qualification cost

`target-contract.spec.ts` marks ten HTTP/session/datastore contracts with
`@server`. They run once per permanent target in `chromium-desktop`, keeping
all five permission personas, API/MCP/Extension contracts and deep revision
save/restore. Those checks do not exercise browser rendering.
The actual browser password login/logout and shell viewport checks still run
in Chromium desktop, 390px, 320px, Firefox and WebKit. The full remote plan
therefore has 20 executions instead of 60, with all 12 distinct contracts intact.
`remote-contract-plan.test.mjs` checks the real Playwright discovery output.
Do not add `@server` to tests that depend on DOM, browser APIs or viewport behavior.
Mutable journeys on the shared permanent site remain sequential.
