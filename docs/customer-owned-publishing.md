# Customer-owned publishing implementation

Typeroll publishes generated source in one direction to the customer's GitHub
organization. The customer's Cloudflare account builds that source and serves
static files. Typeroll remains the supported editor: manual repository changes
are not imported and the next publication replaces the generated tree.

## Organization, Hosting Group and Site

An Organization connects GitHub and shared media/DNS access under **Settings →
Publishing**. Hosting Groups connect the Cloudflare accounts used for site
builds and hosting. Default automatically reuses the existing organization
connection; additional groups can use other accounts. Each hosting account’s
Cloudflare GitHub integration must have access to newly generated repositories.

Each Hosting Group has an optional site-address base. The organization retains
one shared media hostname and original-media storage. DNS for sites2.example.com
can remain in the account managing example.com while its Pages projects live
in another group’s account. See [Hosting Groups](hosting-groups.md). Each Site has its own generated private repository, Pages
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
Referenced public files and responsive image variants are included in the
static website output by default. A separate site media hostname is registered
on the same static Pages project for new configurations. Existing R2 media
hosts keep their routing. Shared aliases remain in the organization's public
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
Automatic DNS changes use the account owning the selected DNS zone and compare the approved record
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

- Personal GitHub account or organization with a publisher App installation covering **all
  repositories** in that account, with repository Administration and
  Contents write permissions. Prefer a dedicated site organization to scope
  this access. A personal account also uses an encrypted, renewable GitHub App user grant to
  create repositories. Publication and build dispatch must still prove installation
  access; a manually supplied PAT does not replace that proof.
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

Independent media builds should use the supported Linux build environment.
Different image encoders across operating systems can generate different bytes;
immutable asset verification deliberately rejects such collisions.


## Check existing GitHub permission updates

`GET /api/v1/publishing/github-permissions` requires an organization API key.
`check_organization_github_permissions` exposes the same check through MCP,
without requiring a site. Browser organization admins use Publishing → GitHub
account → Check GitHub permissions.

The check reads the authenticated App registration and saved installation live.
It returns `publisher_update_required` when the operator has not requested
Actions/Workflows write, `approval_required` with the existing installation URL
when its owner can approve, or `up_to_date` when both grants are effective.
The UI checks again when the user returns from approval and displays an explicit
confirmation. Checking does not reconnect, change the connection revision, mint
an installation token, dispatch a workflow or switch build providers.


## GitHub-hosted Linux sandbox support

GitHub's Ubuntu 24.04 runner restricts unprivileged user namespaces. A sandbox
binary extracted to a temporary directory has no matching AppArmor profile and
cannot initialize the build namespace. Do not disable the kernel restriction.

The `github-sandbox.mjs` bootstrap installs the exact checksum-pinned Bubblewrap
binary and AppArmor's checksum-pinned stacked child profile on an ephemeral
GitHub-hosted x64 Linux VM. Only this trusted host setup runs with root access;
the executor and build source run as the ordinary runner user. Conflicting
installations or local policy overrides are rejected. Self-hosted runners and
local desktop hosts are not eligible for this bootstrap.

The executor selects `/usr/bin/bwrap` only when the binary and its parent
directories are root-owned and not writable by other users, the file is not a
symlink or setuid/setgid, and its bytes match the verified archive exactly.
Otherwise it retains the existing extracted sandbox. Namespace, network,
capability, environment and output checks remain mandatory. Installing this
support is not evidence of a qualified GitHub publishing adapter.

Upstream policy source:
https://gitlab.com/apparmor/apparmor/-/blob/v4.0.2/profiles/apparmor/profiles/extras/bwrap-userns-restrict


## Organization build provider

In **Publishing → Builds**, choose **Cloudflare** or **GitHub Actions** to view
that provider's saved setup. This choice of view does not change publishing.
After setup passes its verification, **Use GitHub Actions for new builds** or
**Use Cloudflare for new builds** saves the organization default with explicit
confirmation. Each pending publication retains its frozen provider, source
commit and site version. Updating one provider does not reconnect the other.

For GitHub, connect the organization's existing Publisher App and approve
Actions and Workflows write access in the **GitHub account** card if requested.
Prepare the organization's R2 media storage, then select **Finish build setup**.
Typeroll creates one private generated runner repository and verifies GitHub
identity, isolated execution and real R2 source/artifact transfer. Site source
repositories and version branches remain separate. A failed check cannot make
GitHub selectable for publishing. Setup uses the organization's GitHub Actions
allowance; the hosting account does not need a GitHub integration for this path.

The trusted GitHub workflow runs only on an explicit Typeroll dispatch. It uses
OIDC rather than a saved runner secret. Typeroll checks signature, audience,
immutable repository and owner IDs, exact workflow/source commit, App actor,
run and attempt before granting one frozen job. Each retry has a new dispatch
identity. Cancelled or superseded attempts cannot return a usable publication.
The existing qualified executor and static artifact/hosting verification remain
shared with Cloudflare. No image binaries or hosting credentials enter Git.

**Active builds** shows the site, version, provider and queued/building status.
An organization administrator can cancel a GitHub build there while it is
queued or building. Cancellation revokes its attempt before requesting GitHub
to stop the run; if GitHub is unavailable, the revoked attempt still cannot
publish. Once building finishes, this control cannot undo a publication.

Organization API keys have the same controls at `GET/POST /api/v1/publishing/builds`:
GET returns the selected engine at the top level for compatibility, plus
`selection`, `engines.cloudflare`, `engines.github` and `active_jobs`. POST
`action: "setup"` or `"check"` accepts `provider` and that engine's `revision`.
POST `action: "select"` accepts `provider` and `selection.revision`. POST
`action: "cancel"` accepts an active GitHub task's `key`. Omitted `provider`
continues to mean Cloudflare for existing setup/check clients. Site API keys
cannot manage organization builds.

The matching MCP tools are `read_organization_build_engine`,
`check_organization_build_access`, `setup_organization_build_engine`,
`select_organization_build_provider` and `cancel_organization_build`.
These tools work before a site exists. Self-hosted servers use their configured
public HTTPS URL as the OIDC audience and the same organization-owned storage;
this workflow does not require Typeroll Cloud authentication or hosting.
