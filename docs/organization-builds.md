# Organization build execution

Source storage, build execution and static hosting are separate responsibilities.
The accepted Cloudflare design uses one generated runner repository and one
Workers Builds project per organization. Sites retain independent repositories
and version branches. Hosting Groups receive static artifacts and do not need
the organization's GitHub installation.

## Current implementation status

The shared executor is connected to the existing frozen customer publication
pipeline. Setup provisions the organization repository, disables automatic Git
build triggers, installs the pinned executor and checks isolated execution plus
private artifact transfer before enabling new shared publications. Existing
in-flight native Pages jobs retain their original backend.

Release qualification must additionally exercise real Astro publications,
media and version branches in the selected Hosting Groups. The initial setup
check verifies the executor and transport; it does not measure a 50-page build
or claim that every customer extension has been exercised.

## Setup and permissions

Open **Publishing → Builds → Finish build setup** to prepare the engine.
**Check build setup** reads the current permission and verification status. This checks the existing
organization Cloudflare account for Workers Scripts and Workers Builds access.
When permission is missing, select **Approve build permissions**, approve the
requested access in Cloudflare, return to Publishing and check again. This uses
the existing connection and preserves its R2 credentials and hosting identity.
No GitHub reinstallation or Hosting Group reconnection is required for this step.

Self-hosted operators must register the following optional scopes on their
Cloudflare OAuth client before offering build consent:

- `workers-scripts.read`
- `workers-scripts.write`
- `workers-ci.read`
- `workers-ci.write`

The application requests them only for organization build consent, not for
ordinary Hosting Group connections. Later organization reconnections preserve
previously granted build scopes. OAuth consent does not automatically create
a Workers Builds deployment token. If no token exists, the access check reports
that requirement separately.

### First build token

When the organization build project exists and the token is missing, Builds
shows **One-time setup in Cloudflare**, an account-specific **Open Cloudflare
setup** link and collapsed **Step-by-step instructions**. The instructions name
the build account, Worker and generated repository. They describe **Settings →
Builds → Connect**, branch `main`, build command `npm run build`, deploy command
`npm run qualify:artifact`, and **API token → Create new token**. Both commands
can be copied. Before Typeroll installs runner authentication, these commands finish with a
setup-pending notice. They do not publish a customer site. An already connected project can use **Settings → Builds
→ API token** directly.

After saving in Cloudflare, returning to the Typeroll tab checks the setup.
**I’ve finished — check again** also performs that check and displays a persistent
text result. If no token is found, the instructions remain available. If one is
found, the card confirms **Build token found · Verification pending**; it never
marks the engine ready on that basis alone. The token value stays in Cloudflare.
OAuth reconnection and tokens in individual Hosting Groups are not required.

If the expected Worker is missing, **Finish build setup** creates the generated
private repository and a Worker anchor with public URLs disabled. After the first
build token exists, select the same button to complete setup. Typeroll configures
the trigger and secret, dispatches a verification build and updates the card
automatically. **Update build engine** installs the current pinned executor;
updates wait until current queued or running builds finish.

Cloudflare currently does not expose `API Tokens Write` in its OAuth scope
catalog. Its build-token creation endpoint registers an existing API token
secret/ID. Do not substitute an expiring OAuth access token. See
[Cloudflare build tokens](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)
and [token creation via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/).

## API and MCP

Organization API keys can read `GET /api/v1/publishing/builds` and check access
with `POST /api/v1/publishing/builds`, JSON body `{ "revision": "<current revision>" }`.
Pass `"action": "setup"` with the current revision to provision or update the
engine. Site keys are rejected. Requests cannot select another organization through their
body. Responses contain safe status and numeric provider diagnostics, never
provider tokens. Reads and writes disable response caching.

MCP exposes `read_organization_build_engine` and
`check_organization_build_access` and `setup_organization_build_engine`. None requires an existing site.

## Frozen build and lease contracts

Protocol 1 pins the organization, site, version, job, publication hash, exact Git
commit, branch, source hash and Node version. Source packages contain text files;
image inputs must use separate scoped grants. Artifacts contain bounded static
files with per-file hashes and the matching publication marker. Reject source
or artifact corruption, path traversal, duplicate output paths and dynamic
Worker/Functions output before deployment.

Each organization queue uses the existing datastore's atomic conditional writes.
Concurrent claims acquire distinct jobs, expire after 90 seconds without a
heartbeat, and stop retrying after three attempts or the 45-minute job deadline.
Each attempt gets its own token and artifact path. Completion revokes the token;
cancellation and reassignment reject stale completion. Runner endpoints use separate organization and attempt tokens, never browser
cookies or public API keys. A cancelled publication cannot renew its attempt or
obtain an upload grant. Upload grants are issued on demand after rendering.

## Isolation, storage and static hosting

The Linux x64 supervisor pins Node and a SHA-256-verified Bubblewrap package.
Source executes as an unprivileged user in separate user, mount, PID and network
namespaces with a read-only root, a synthetic user/group database, cleared environment and no provider tokens or
Docker socket. Dependency installation disables lifecycle scripts. The media
preparation stage receives only publication-scoped object grants. Rendering has
no network. Bundled Extension scripts and styles are fetched through the frozen
renderer’s URL and SHA-256 guards in a separate credential-free preparation
stage, then served from an exact-URL local cache during rendering. Recorded DNS
answers let the frozen URL validator run offline without authorizing new
destinations. A trusted adapter lets older frozen renderers reuse prepared media
without altering files covered by their source manifest.

The existing private originals bucket stores build packages separately from
published media. Public bucket domains are rechecked before granting access.
Inputs and attempt artifacts expire after seven days; previous output manifests
remain available to verify removed URLs in later publications. Retention setup
preserves unrelated lifecycle rules.

Only the Typeroll coordinator uses the selected Hosting Group credential for the
official static Pages uploader. The executor receives no hosting token. Existing
matching Git-connected Pages projects have automatic builds disabled before
source pushes. Each publication retains its exact Git commit and version branch.
The immutable deployment and public hosts must pass publication-marker and
actual-file byte checks; removed routes must return 404. A fresh marker with
stale content keeps the public link hidden while distribution is pending.

Uncertain Cloudflare dispatch responses are reconciled against build history.
They do not cause an immediate second billable dispatch. No engine is enabled
solely because permission checks or the first token setup succeeded.

## Public availability checks

Publishing verifies actual static response bytes and deleted routes before exposing
the new live URL. Small publications are checked in bounded concurrent batches
within one observation; larger publications resume persisted progress. A skipped
Pages Git trigger is not an uploaded deployment when migrating an existing project.

When a process still reports a newly created hostname as missing, the availability
check can resolve public IPv4 records through Cloudflare DNS over HTTPS and pin
its HTTPS connection to those validated addresses. Private addresses, certificate
failures and redirects to other origins remain rejected. This does not replace
customer DNS configuration or weaken the output checks.
