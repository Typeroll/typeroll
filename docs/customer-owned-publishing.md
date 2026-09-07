# Customer-owned publishing implementation

The target architecture is one-way publication from Typeroll to customer-owned
Git repositories, builds, media storage, and static hosting. Typeroll remains
the supported editor. Each site version can publish to a generated
`version-<id>` Git branch; `main` serves the production site. Merging content
happens in Typeroll before generating the next complete publication tree.

## Current implementation boundary

The phase-zero provider probe is implemented in
`scripts/customer-publishing-probe.mjs`. It generates three synthetic 50-page
Astro source projects, creates or resumes dedicated private repositories and
Git-connected Pages projects, and checks a separate version preview without
moving the published site. It also verifies one direct presigned R2 upload and
readback in an existing bucket. It never attaches customer domains or imports
customer content.

This is the provider onboarding probe. The portal now shares the provider
boundary for organization account connections, but its publish action is not
yet connected to Git. The synthetic renderer does not prove
parity with Typeroll's renderer, Forms, Extensions, media optimization, preview,
or a complete snapshot export. Those remain subsequent implementation gates. A successful
Node upload does not establish browser CORS or tenant authorization; both need
their own application tests.

### Organization account connections

The Core 0.1.15 candidate adds `/app/settings/publishing` and the
`/api/orgs/publishing` routes. Explicit organization owners/admins can verify a
GitHub App installation using GitHub OAuth with PKCE and organization-owner
verification, and connect encrypted Cloudflare/R2 credentials. Account ownership
claims prevent cross-tenant reuse; connection revisions protect rotation and
disconnect against stale requests. The shared provider implementation is in
`packages/portal/src/lib/publishing/providers.mjs`; the CLI keeps its existing
import through a re-export.

Cloudflare connection verifies account/Pages read access and R2 object
write/read/delete access. It does not create Pages projects, connect Cloudflare's
GitHub App, configure public media domains/CORS, or migrate media. Standard
global R2 buckets are supported in this first connection. GitHub App registration
and a real customer account trial remain pending; local automated tests do not
count as that evidence. See the [setup guide](customer-owned-publishing-setup.md)
for App permissions, environment variables, and exact callback configuration.

### Portable HTML publication

`scripts/lib/static-publication.mjs` adds an initial real-renderer source
generator for HTML sites without Forms, active modules, Extensions, collections,
custom blocks/templates, or custom redirects. Unsupported features fail closed.
This bounded generator is separate from the synthetic three-site provider probe
and is not wired to the portal's publish action.

`projectStaticPublication` allowlists public fields, excludes drafts and unused
media, and records permanent media URLs plus precomputed variants. It does not
publish a raw CMS export. `createStaticPublicationProject` vendors the Core
renderer, shared source, and static postprocessing with a fixture-only data
reader. A generated dependency lock and `sealPublicationProject` freeze the
source files before publication. The resulting repository builds with
`npm ci && npm run build` and outputs `dist/` without contacting the CMS.

The build invokes Astro through the current Node binary instead of the host's
npm shim. A real generated-renderer regression test runs without HOME and with
an unusable npm shim, covering the managed build environment failure observed
during the first provider build.

This first contract preserves existing media delivery URLs; it does not migrate
storage or optimize images. Portable builds therefore still depend on retaining
those media resources. Pilot publications default to noindex and preserve the
original canonical site URL. This is source for an independently buildable
static publication, not a complete CMS backup.

Run the focused public projection and real-renderer checks with:

```sh
node --test scripts/static-publication.test.mjs
```

## Account prerequisites

Follow the [customer account setup guide](customer-owned-publishing-setup.md)
for the customer-facing permissions and credential contract. Personal developer
membership and personal Git tokens are not substitutes for the customer App
installation in the onboarding proof.

Use the intended agency/customer organization and account, or explicitly
approved synthetic test accounts. The GitHub App belongs to the publisher;
install it once on the organization's site repositories. An existing suitable
account can be used. A different account per site is unnecessary.

- GitHub organization with a publisher App installation covering **all
  repositories** in that organization, with repository Administration and
  Contents write permissions. Prefer a dedicated site organization to scope
  this access. The probe rejects user/PAT substitution because that would not
  prove installation access to newly created repositories.
- Cloudflare's own GitHub App must also be installed once and cover newly
  created repositories. The probe deliberately cannot substitute Typeroll's
  installation for Cloudflare's. Successful creation and builds of all three
  projects are the evidence that both connections work.
- Cloudflare token scoped to the intended account, with Pages edit and account
  details read access.
- R2 enabled with an existing dedicated media bucket and R2 object read/write
  credentials scoped to that bucket. This first probe does not create billing
  subscriptions, rotate credentials, or provision the bucket.
- The organization's initial default branch must be `main`.

Keep account IDs and configuration separate from credentials. Configure these
secret environment variables through the deployment's secret manager:

```text
TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY
TYPEROLL_PUBLISH_CLOUDFLARE_TOKEN
TYPEROLL_PUBLISH_R2_ACCESS_KEY_ID
TYPEROLL_PUBLISH_R2_SECRET_ACCESS_KEY
```

Never put their values in the plan, CLI arguments, repository, or reports.
Installation tokens are minted in memory for each invocation. The probe only
prints selected resource identities and verification states; provider response
bodies and presigned URLs are not printed.

## Prepare and review

Place a non-secret configuration under the ignored `test-results/` directory.
The values below are synthetic examples and must be replaced with the intended
account identifiers before a remote run:

```json
{
  "github_owner": "synthetic-agency",
  "cloudflare_account_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "github_app_id": "12",
  "github_installation_id": "34",
  "prefix": "tr-probe-synthetic",
  "media_bucket": "synthetic-media"
}
```

```sh
node scripts/customer-publishing-probe.mjs --config test-results/publishing-probe.json
node scripts/customer-publishing-probe.mjs --config test-results/publishing-probe.json --prepare test-results/generated-sites
cd test-results/generated-sites/tr-probe-synthetic-01
npm ci
npm run build
```

The default command makes no provider calls. It displays exact account and
resource identities, a fingerprint of configuration plus implementation/source,
and the remote effects. Changing the code or fixture invalidates an earlier
fingerprint. Preparation
refuses to overwrite an existing output directory. Generated projects include
Astro source, a package lock, 50 content records, a frozen content manifest, and
static noindex headers. No CMS or Cloudflare credential is needed for the local
build. The source generator is intentionally limited to synthetic fixtures;
passing a raw CMS export is unsupported.

## Run the approved probe

After the operator has approved the exact account, resource names, and effect,
inject the scoped credentials and run:

```sh
node scripts/customer-publishing-probe.mjs --config test-results/publishing-probe.json --apply --confirm-plan PLAN_FINGERPRINT
```

Run the same command again after Cloudflare finishes building. Each invocation
does one observation pass and exits; it does not sleep or install another
automation. Exit codes are `0` for verified, `2` for pending builds, and `1` for
failure. A failed deployment is not automatically retried or rebuilt on the
publisher's account. Investigate the provider failure before a separate retry.

The probe uses three private repositories named `<prefix>-01` through
`<prefix>-03`, three identically named Pages projects, and one object under
`<prefix>/<fingerprint>/` in the media bucket. Initial project/branch builds may
bring the total to eight builds. It retains resources for inspection. Their
later deletion requires an explicit resource-specific operation.

Existing resources are only resumed when their owner, private visibility,
probe marker, Git source, branch rules, build configuration, and absence of
custom domains agree with the plan. The probe does not silently adopt another
repository, change a Direct Upload project, or repair a customer's settings.

## Publication behavior and evidence

`publishTree` creates an entirely new Git tree without a `base_tree`, preserves
the previous commit as parent, and advances the ref without force. It removes
stale/generated/manual files, skips unchanged trees, and leaves `main` unchanged
when publishing a version branch. Concurrent ref changes fail instead of
force-overwriting history. Production integration still needs a durable queue
per site/version and publication records; the probe is a single-operator tool.

The observer matches project, branch, commit, environment and successful deploy
stage. It rejects skipped builds and Functions, checks the immutable deployment
URL, and verifies that production is the project's actual canonical deployment.
It reads both the first and fiftieth pages and checks site/revision markers.
After creating a version preview it checks production again.

Local tests:

```sh
node --test scripts/customer-publishing.test.mjs
node scripts/customer-publishing-smoke.mjs
```

These include real local Git objects/history and provider contract tests. The
smoke command installs the generated project's pinned dependencies, blocks Node
network access during rendering, verifies 50 static pages, and rejects a
controlled content mutation after snapshotting. Evidence stays under the
ignored `test-results/customer-publishing/` directory. These checks
do not count as an executed GitHub/Cloudflare onboarding proof. Record the
remote result separately before marking the phase-zero gate passed.

Provider contracts reviewed 2026-09-06:

- [GitHub repository creation](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository)
- [GitHub tree creation](https://docs.github.com/en/rest/git/trees#create-a-tree)
- [GitHub App installations](https://docs.github.com/en/rest/apps/apps#get-an-installation-for-the-authenticated-app)
- [Cloudflare Pages project creation](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/)
- [Cloudflare GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)
