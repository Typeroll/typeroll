# Migrate existing static hosting

Typeroll CMS can move one existing managed Cloudflare Pages site to connected
Git publishing while retaining its static Direct Upload project and live host.
Connecting organization R2 alone does not migrate an existing managed Pages
site. Its uploads, content references and publisher remain unchanged until the
site explicitly opts in. New connected sites still use private draft storage
before organization storage is configured.

## Prepare

Back up CMS data before migration and record the current Core release. In
**Publishing**, connect GitHub and the site's original Cloudflare account, then
finish and verify the shared build engine. Configure organization media storage
and its media host if the site has media. A different hosting account needs a
separate hosting and domain migration; this operation does not move accounts.

The original project must use Direct Upload, serve static files and use `main`
as its production branch. The existing custom website host must remain attached.
Wait for active site publications to finish. Keep the current host during this
migration; prepare later domain changes using the normal verified cutover flow.

## Migrate one site

Open the site's **Settings → Publishing → Move this site to connected
publishing**. Select **Check migration**, inspect the host and existing project,
then select **Migrate this site**. The result confirms that settings were saved.
This action does not deploy or change traffic DNS.

Media copying starts immediately and continues automatically in the background,
including large libraries. You can close the browser; **Publishing → Media storage**
shows verified copies and any retry that needs attention. Original URLs remain
available. Once the transfer finishes, publish the site. Typeroll freezes the source into the site's generated
GitHub repository, builds through the selected organization engine, and uploads
static output to the original Pages project. Version branches keep using that
project. A missing adopted project is an error, never an instruction to create
a replacement project.

Verify public pages, assets, links, canonicals, indexing and runtime integrations
against the expected content before treating migration as complete. A saved
migration receipt or a successful upload alone is not publication verification.

## API and AI agents

Site admins can use the same operation without the UI:

- `GET /api/v1/sites/{siteId}/publishing/managed-migration` verifies prerequisites
  and returns `state`, `revision` and the existing hosting binding.
- `POST /api/v1/sites/{siteId}/publishing/managed-migration` with
  `{ "revision": "value-from-the-check" }` opts in this site. Stale revisions,
  active publications, different accounts and mismatched projects are rejected.
- MCP tools: `check_managed_site_migration` and
  `migrate_managed_site_publishing`. Both use the same authenticated API.

## Recovery

The server-managed migration receipt records the original account, project,
website host and live deployment ID. Keep the old Pages deployment and source
media during acceptance. If publication fails, inspect the deployment status;
retry does not create a new hosting project. If a new main upload needs to be
rolled back, restore the recorded deployment through Cloudflare and verify its
public response. Reverting CMS or publication ownership after media migration
requires the pre-migration backup and a deliberate recovery operation; do not
flip the publishing mode back while references point to private media.

## Media worker and recovery

A migration request persists its work and dispatches the configured worker
immediately. Cloud Tasks uses the existing authenticated deploy-worker endpoint
with a media-only task; it does not start a site build or change DNS traffic.
Each task handles up to 100 records or 45 seconds before accepting its next
continuation. Slow individual transfers have separate timeouts. There is no
five-minute wait between successful batches. The scheduled sweep only recovers
work whose initial dispatch or worker was interrupted.

Portable Firestore workers poll persisted media jobs independently of builds.
The in-process development backend continues locally but is not durable across
process exits without the recovery sweep.

A saved site/media cursor avoids rereading a large library from its beginning
after every batch. References across versions are rewritten after a site's
copies; reference cursors and optimistic writes preserve concurrent edits.
Late uploads request another pass, including when they sort before the cursor.
Copy counters survive a crash between saving the verified copy and saving its
cursor. Integrity failures pause immediately; interrupted transfers retry up to
three times before showing an actionable error. Retry resumes verified progress.
The UI reports verified copies, not an estimated remaining count before the
library has been scanned. Neither a successful transfer nor retry deletes the
source files or publishes a site.
