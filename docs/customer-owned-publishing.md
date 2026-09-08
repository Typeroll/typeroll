# Customer-owned publishing implementation

Typeroll publishes generated source in one direction to the customer's GitHub
organization. The customer's Cloudflare account builds that source and serves
static files. Typeroll remains the supported editor: manual repository changes
are not imported and the next publication replaces the generated tree.

## Organization and Site

An Organization connects one GitHub App installation and one Cloudflare account
under **Settings → Publishing**. The connection covers newly created site
repositories, so it does not need repeating for every Site. Cloudflare's own
GitHub integration must also have access to those repositories.

Organization settings separate the optional site-address base from the shared
media hostname. Each Site has its own generated private repository, Pages
project, website hostname, media hostname and version branches. Root-domain
hosting and unrelated subdomains are outside this configuration.

Editing, AI-agent access, saving, private uploads and temporary previews can be
used before publishing accounts or domains are connected. Customer publication
is gated by the readiness API and points to Publishing when setup is incomplete.
See the [setup guide](customer-owned-publishing-setup.md) for navigation,
permissions, DNS options and runtime configuration.

## Frozen source and version branches

The portal's customer publication queue freezes the selected version before
calling GitHub. Pages, blocks, templates, collections, redirects and public
runtime settings are projected into an independently buildable Astro project.
Draft content and private configuration are excluded. Supported public content
is rendered by the vendored Core renderer, rather than a second synthetic
renderer. Unsupported content fails validation.

`main` is the site's production branch. A Typeroll version publishes to its own
`version-<id>` branch and preview address. Content merges happen in Typeroll.
Subsequent edits do not alter an in-flight publication snapshot. Complete Git
trees remove obsolete generated files; ref updates preserve history and never
force-push over a concurrent change.

The generated repository includes a dependency lock, source integrity manifest
and public publication manifest. `npm ci && npm run build` produces `dist/`.
It is a static publication snapshot, not a complete CMS backup. Independent
builds require access to the referenced customer media. Forms, Apps and
Extensions may still depend on their declared runtime owners.

## Media and runtime dependencies

Before customer storage is ready, uploads use private draft storage. Once
verified organization storage is active, new uploads go directly from the
browser to that account's private R2 bucket. WordPress media imports follow the
same storage policy. Original bytes are verified before media becomes ready.
Organization migration verifies copies and reference changes while preserving
media identities and concurrent edits.

Customer builds receive short-lived, object-specific media grants outside Git.
Originals and responsive image variants are written to the customer's public
media bucket. Image bytes, S3 keys and upload grants are never committed to the
source repository. Organization and retained site-media aliases continue to
refer to the same immutable objects after a hostname change.

Forms and Extensions use their existing public runtime contracts. Only public
endpoint/configuration data enters the snapshot; action credentials do not.
Dynamic requests go directly to the runtime owner. The website itself must
remain a static Pages deployment without Functions.

## Publication verification and domain changes

A successful Git push is not a successful publication. The publisher matches
Cloudflare's project, branch, commit and deployment environment, verifies static
output and probes the immutable publication marker before reporting availability.
Provider build status is available through the authenticated site API and MCP
`get_deploy_status` with `include_provider: true`. It excludes provider secrets
and environment-variable configuration.

A domain change freezes future website/media origins into a candidate before
traffic cutover. The preparation API reports certificate and DNS requirements;
external agents can apply those requirements with their own DNS access.
Automatic DNS changes use the connected account and compare the approved record
fingerprint to prevent overwriting intervening edits. Typeroll independently
verifies the candidate and public result. Existing-destination conflicts must be
resolved explicitly; a saved hostname alone does not establish a safe cutover.

Customer publishing cost records sum active publisher attempts. They exclude
queue backoff and the customer's asynchronous build time. These are gross
compute estimates, not invoice allocations: concurrent requests can share an
instance, and CMS, preview, database and storage costs remain separate.

## Evidence boundary

Local source-generation, queue, provider, authorization and browser tests cover
these contracts. Passing them does not prove a customer's actual GitHub,
Cloudflare, media or DNS setup. Record live customer-account results separately,
including create/edit/delete, publication status, branches, private uploads,
public assets, indexing, domain transitions and independent repository builds.

## Optional provider probe

Follow the [customer account setup guide](customer-owned-publishing-setup.md)
for the customer-facing permissions and credential contract. Personal developer
membership and personal Git tokens are not substitutes for the customer App
installation in the onboarding proof.

Use the intended organization and account, or explicitly
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
  "github_owner": "synthetic-organization",
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
force-overwriting history. The portal uses a durable queue and per-version publication records; this separate
probe remains a single-operator diagnostic tool.

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
