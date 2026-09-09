# Organization build execution

Source storage, build execution and static hosting are separate responsibilities.
The accepted Cloudflare design uses one generated runner repository and one
Workers Builds project per organization. Sites retain independent repositories
and version branches. Hosting Groups receive static artifacts and do not need
the organization's GitHub installation.

## Current implementation status

The organization Builds card, cookie and public API access checks, optional
Cloudflare build permission consent and MCP access checks are implemented.
The frozen source/artifact contract and transactional organization queue are
implemented and tested as foundations. They are not connected to the customer
publication runner yet. The shared Cloudflare executor, provider provisioning,
artifact transfer, Direct Upload integration and cross-account qualification
remain pending. Existing customer Git publications still use native Pages builds.
Do not interpret successful access checks as an enabled or qualified build engine.

## Setup and permissions

Open **Publishing → Builds → Check build setup**. This checks the existing
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
can be copied. These commands run the initial synthetic connection test, not a
customer publication. An already connected project can use **Settings → Builds
→ API token** directly.

After saving in Cloudflare, returning to the Typeroll tab checks the setup.
**I’ve finished — check again** also performs that check and displays a persistent
text result. If no token is found, the instructions remain available. If one is
found, the card confirms **Build token found · Verification pending**; it never
marks the engine ready on that basis alone. The token value stays in Cloudflare.
OAuth reconnection and tokens in individual Hosting Groups are not required.

If the expected Worker is missing, the UI reports project preparation as pending
instead of linking to a nonexistent project. Automatic project provisioning is
not yet implemented; this guide supports the prepared qualification project.
Runtime qualification must establish the complete setup flow before claiming
that setup or publishing is automatic.

Cloudflare currently does not expose `API Tokens Write` in its OAuth scope
catalog. Its build-token creation endpoint registers an existing API token
secret/ID. Do not substitute an expiring OAuth access token. See
[Cloudflare build tokens](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)
and [token creation via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/).

## API and MCP

Organization API keys can read `GET /api/v1/publishing/builds` and check access
with `POST /api/v1/publishing/builds`, JSON body `{ "revision": "<current revision>" }`.
Site keys are rejected. Requests cannot select another organization through their
body. Responses contain safe status and numeric provider diagnostics, never
provider tokens. Reads and writes disable response caching.

MCP exposes `read_organization_build_engine` and
`check_organization_build_access`. Neither requires an existing site.

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
cancellation and reassignment reject stale completion. These internal queue
methods must only be exposed after runner authentication, artifact storage and
publication-authorization integration are qualified.
