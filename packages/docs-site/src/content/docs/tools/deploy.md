---
title: Deploy Tools
description: Build and deploy your static site to Cloudflare Pages.
---

## `trigger_deploy`

Starts a new deploy. Returns a `job_id` that the AI agent uses to track progress.

```
Deploy the site.
```

Ask the agent to deploy explicitly after you have reviewed and saved the intended changes.

### Before you publish

A deploy publishes everything that is saved on the site, not only your own
changes: edits by other people and by other agent sessions ship too. Before a
real deploy:

1. Review your edits with `get_preview_link` and `include_working_copy: true`.
   Target the changed page (`page_id` or `slug`) so its path is in the link,
   and use the returned `frame_url` for screenshots and rendering checks.
2. Save the working copies you want to publish. Unsaved working copies are not
   deployed.
3. Run `trigger_deploy` with `dry_run: true` and read `get_publication_impact`.
   If it lists changes you did not make, stop and find out whose they are.

After switching an app's version, dry-run and publish soon: the live site keeps
the version it was published with until the next publication.

### Deploys after cutover

Before a site is cut over, a deploy publishes to its temporary, noindexed
address. Publishing to the temporary address ends at cutover: once the site
serves its live custom domain, the same publication serves both, so every
real deploy is a production release.

For such a site, a deploy that is not a dry run must include
`confirm_live_domains: true`, and only after the site owner approved this
release. Without it the call is refused with HTTP 409 and the code
`live_domain_confirmation_required`. The error names the live URLs and
returns them in `live_domains`, together with `targets` and
`production: true`, so the agent can show the owner exactly what will
change:

```json
{
  "code": "live_domain_confirmation_required",
  "error": "This site is live at https://example.com. Deploying publishes the saved content to https://example.com and https://site-….sites.example.net immediately: …",
  "requires_confirmation": true,
  "production": true,
  "live_domains": ["https://example.com"],
  "targets": ["https://example.com", "https://site-….sites.example.net"]
}
```

Every deploy result reports `production`, `live_domains` and `targets` (live
domains first, then the temporary address), and the deploy job records
`targets`, `production` and `live_domains_confirmed`. A site that is not cut
over reports `production: false` with its temporary address and needs no
acknowledgement. Dry runs, `get_preview_link` (including
`include_working_copy`) and `get_publication_impact` never need it, and a
verification retry of an already-confirmed job does not ask again. Use
`get_preview_link` with `include_working_copy: true` to review changes on a
live site without publishing. A production `rebuild_deploy` workflow takes the
same `confirm_live_domains: true` in its config. In the portal, the Publish
button names the live domains in its confirmation before it publishes.

### Dry runs

Pass `dry_run: true` to validate without publishing. Customer publishing validates
the frozen source without pushing Git or starting an external build. It also
applies validation rules that need no rendering: an image link without an
accessible name (`<a><img alt=""></a>` without text, or an image block with a
`link` and empty `alt`) fails the dry run with `publication_validation_failed`,
as the build would after media preparation. It does not prove that Astro
compilation succeeds or that the rendered pages pass every other check. Other self-hosted adapters may build
locally without uploading. Inspect the reported phase; a successful dry run has
`dry_run: true` and no `deploy_url`.

### Missing media

Every publication checks once, before anything goes live, that each media file
its content references is in the site's media storage. Dry runs make the same
check. It reads the media records only; nothing is downloaded and nothing keeps
checking afterwards.

A file counts as missing when nothing will copy it without someone acting:

- the media migration set its copy aside after its attempts were used up or the
  source was refused (the media migration reports it among its failed files),
- an imported source was rejected (for example an SVG that is not a usable
  image), or
- no stored copy and no pending import exists.

Missing files fail the deploy job with `job.failure.code` `media_missing`.
`job.failure.missing_media` lists them (at most 100) and
`job.failure.missing_media_total` counts them all:

```json
{
  "status": "failed",
  "error": "Cannot publish: 99 referenced media file(s) are missing from this site's media storage because their copy failed and was set aside (…). Retry the media migration in Publishing or import those files again, or publish with accept_missing_media: true to leave their references empty. missing_media lists the files.",
  "failure": {
    "stage": "freezing source",
    "code": "media_missing",
    "missing_media_total": 99,
    "missing_media": [
      {
        "media_id": "m_123",
        "filename": "hero.jpg",
        "source_host": "old.example.com",
        "code": "media_transfer_unavailable",
        "reason": "The transfer was interrupted."
      }
    ]
  }
}
```

`source_host` is only the host of the file's original address, never the full
URL, which may carry a token. `code` and `reason` are the recorded copy
failure. Fix the files first: retry the media migration in Publishing, or
import or upload them again. If the site owner accepts publishing without
them, deploy again with `accept_missing_media: true`. Their references are
then left empty (an image renders as no file, never as a private Typeroll
address), and `job.warnings` names each file, or summarizes them when there
are more than 20. The job records `accept_missing_media: true`.

Files that are still uploading, waiting to be copied or waiting for an
automatic import retry are not missing. They fail the deploy with
`media_migration_pending` and their count, with or without
`accept_missing_media`: wait for the media migration to finish, then deploy
again. A domain change rebuilds the last publication and never accepts
missing media.

## `get_publication_impact`

Reports where a deploy lands and which saved public content changed since the
last verified publication. `production` is `true` when the site is cut over;
`live_domains` lists its live URLs and `targets` every public URL the
publication serves, live domains first. It never builds or publishes.

The comparison needs a baseline: the saved source recorded by the version's
last verified publication. `changes_known` says whether there was one.

- `changes_known: true` (`comparison: "verified_snapshot"`): `total`,
  `changed_pages`, `added_pages`, `removed_pages` and `changes` are the net
  saved public changes since that publication, which `baseline_publication_id`
  names. `total: 0` means nothing public changed.
- `changes_known: false` (`comparison: "baseline_unavailable"`,
  `classification: "unknown"`): nothing was compared. `total` stays `0` and
  `changes` empty for older clients, but the changes are **unknown, not
  none**. `baseline.reason` says why and `baseline.message` what to do.

| `baseline.reason`                  | Meaning                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `not_published`                    | This version has not been published yet.                                                                       |
| `publication_not_verified`         | Its last publication did not succeed or was a dry run.                                                         |
| `snapshot_without_source_baseline` | Its last publication records no saved source: it is from before Core 0.2.0, or a domain change built from one. |
| `baseline_snapshot_unreadable`     | The publication a domain change was built from can no longer be read.                                          |
| `baseline_identity_mismatch`       | The recorded source belongs to another organization, site or version.                                          |

Without a baseline, the next publication still builds and publishes every
saved public page, exactly as with one; only the preview is missing. Publish
once to record a baseline for later comparisons. Until then, run
`trigger_deploy` with `dry_run: true` to validate the full build without
publishing (a dry run does not record a baseline).

A domain change republishes the previous publication's content at the new
addresses. From Core 0.3.28 it records that publication's source as its own
baseline. For a domain change prepared by an earlier release, the comparison
uses the publication it was built from and adds `baseline_predates_domain_change`
to `reasons`; the publication addresses are then listed as changed, because
that baseline predates them.

## `get_deploy_status`

Polls the deploy job for status. The AI agent calls this in a loop until the deploy completes or fails.

Possible statuses:

- `queued` — waiting to start
- `running` — build or distribution in progress
- `succeeded` — deployed successfully
- `failed` — build error (the AI agent will report what went wrong)

Over the API, `GET /api/v1/sites/{siteId}/deploys/{jobId}` returns the job
under `job`, so read the status from `job.status`, not the top level:

```json
{
  "job": { "status": "running", "warnings": [] },
  "build_progress": {},
  "waiting_for_job_id": null,
  "queue_timeout_seconds": 300,
  "site_urls": { "production": "https://www.example.com" }
}
```

A job that failed with `job.failure.code` `media_missing` lists the referenced
files whose copy to media storage failed in `job.failure.missing_media`; see
[Missing media](#missing-media).

### Queued builds

While the build or verification step waits for a runner, `build_progress.queue`
says why: `waiting_for_provider` (the provider has not started a runner yet;
`provider_status` is its own status, such as `queued`) or
`waiting_for_other_builds` (other builds in the Organization go first). Its
`message` is also the job's `phase`. A queued build is normal: keep polling the
same job and do not trigger another deploy. The step's working time starts when
a runner claims it; only a step no runner claims within 6 hours (`expires_at`)
fails, with `build_queue_timeout`. See
[A queued build that does not start](../../guides/customer-publishing/#a-queued-build-that-does-not-start).

### Partial rendering

From Core 0.2.15, generated publication builds can reuse unchanged HTML. The
optional `job.render_report` records actual `mode` (`full` or `partial`),
`rendered`, `reused`, `total`, `removed` and `reason`. `removed` counts routes in
the available cache that are absent from the current output. This is separate
from `get_publication_impact`, which compares source inputs before the build.

Recorded queries, visited records, references and navigation identify affected
consumers, including after additions and removals. Unchanged addresses are excluded
from the render queue. Missing or invalid cache falls back to full rendering. Both paths produce a complete static
site with regenerated global output. See [Partial builds](../../guides/customer-publishing/#partial-builds)
for engine updates, independent builds and limits. These counts do not measure
provider startup, media processing, upload time or billing savings.

### Build cost

Completed jobs also carry a `cost` object — what the build cost the platform in
server time:

```json
{
  "cost": {
    "currency": "USD",
    "total": 0.00085336,
    "cpu": 0.00077249,
    "memory": 0.00008047,
    "request": 0.0000004,
    "duration_s": 32.187,
    "vcpu": 1,
    "memory_gib": 1,
    "phases": {
      "materializing content": 0.955,
      "building": 17.176,
      "bundling block assets": 0.201,
      "uploading": 6.2
    },
    "output_bytes": 3417900,
    "output_files": 80,
    "estimated": true
  }
}
```

The `phases` breakdown is the useful part when a site starts building slowly —
it tells you which stage is actually consuming the time.

Two caveats worth stating plainly:

- **These are estimates, not billing records.** They're computed from a rate
  card (instance time × allocated vCPU and memory, the way a request-based
  container is billed), not read back from a cloud billing API. Free-tier
  allowances and committed-use discounts are not deducted, so the figures are
  gross and a real invoice comes out lower.
- **Failed builds are costed too.** A build that errors consumes the same
  server time as one that succeeds, so it gets a cost row. A site stuck in a
  build-failure loop should not look free.

Self-hosters can retune the rates — or set them to zero, if you run on hardware
you already pay for — with the `DEPLOY_COST_*` environment variables. See
[Self-Hosting](../../guides/self-hosting/).

## `get_preview_link`

Returns a signed preview URL for the current site state — without deploying. Use this to review changes before they go live.

```
Show me a preview of the site.
```

The preview link is valid for 24 hours and renders saved database state, not
the last deploy. Pass `include_working_copy: true` when the reviewer should also
see unsaved drafts; that choice is signed into the link. Anyone holding the link
sees unpublished content, so creating one needs write permission on the site, in
the portal as well as through the API.

The preview runs in a sandbox without cookies, so a cookie banner returns on
every page. For visual review, add `&consent=all` to the link to answer it for
the whole session: the banner stays hidden and consented scripts and embeds
load. `&consent=necessary` hides the banner and loads only necessary scripts.
The sandbox itself is unchanged; a widget that needs a first-party origin may
still need a test publication.

Use the preview for content and layout review. Its page is a nested frame with
an opaque origin, served from the portal, so third-party iframes often stay
empty, consent choices, cookies and storage do not persist, analytics cannot be
verified, fonts load from Google, and DOM or computed-style reads from a
reviewing browser are limited. Verify those, and any measured design check, on
the published temporary or test address.

## `get_page_preview`

Returns one page rendered as a single HTML document in the response body
(`rendered_html`) together with its `internal_links`, without deploying. The
output matches the portal's **Preview**: header and footer, settings CSS, block
CSS, block JavaScript, installed Extension components and the cookie-consent
banner are all included. Pass `annotate: true` to tag each block's root element
with its block id and type, and `include_working_copy: true` to include unsaved
drafts. Over REST: `GET /api/v1/sites/{siteId}/pages/{pageId}/preview` with
`?annotate=true` and `?working_copy=true`.

Forms in both kinds of preview run in preview mode: they validate and step
through like the published form and show its success message, but store and
send nothing. See [Forms in previews](../forms/#forms-in-previews).

## `read_site_readiness`

A site-level launch report built from saved content and settings. Run it
before launch and after larger changes, then fix each open item or record why
it stays open. It never blocks a publication and never changes content.

```json
{
  "site_id": "...",
  "checked_at": "2026-11-01T12:00:00.000Z",
  "summary": { "ok": 15, "suggestions": 3, "warnings": 2 },
  "items": [
    {
      "id": "share_image",
      "status": "suggestion",
      "message": "No default share image. Pages without their own image fall back to the logo when shared.",
      "fix": "Optional: upload or choose a 1200 × 630 px image, or create one with tr-imagegen, and set it as default_og_image.",
      "guide": "https://typeroll.com/docs/guides/launch-checklist/#share-image"
    }
  ]
}
```

`status` is `ok`, `suggestion` or `warning`. `details` lists up to 20 affected
pages or values. Pass `version` to check a branch. The same report is
available at `GET /api/v1/sites/{siteId}/readiness` and in the portal on the
site overview.

| Item                                         | Checks                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `share_image`                                | `default_og_image` is set (a suggestion when missing), and it and page `og_image` values are not SVG, data URLs or narrower than 600 px                                     |
| `home_description`                           | The home page at `/` exists and has its own `seo_description`                                                                                                               |
| `organization`                               | Organization name and logo for structured data                                                                                                                              |
| `same_as`                                    | Profile links in `organization.same_as` or the social settings                                                                                                              |
| `favicon`                                    | A favicon is set                                                                                                                                                            |
| `analytics_consent`                          | Tracking scripts or Integrations tags run only with the cookie banner; a suggestion when no analytics is set up                                                             |
| `search_console`                             | A Google verification tag in `scripts_head`. DNS verification is not visible to Typeroll, so this stays a suggestion without one                                            |
| `privacy_page`, `contact_page`               | A published privacy page and a contact page or contact details                                                                                                              |
| `not_found_page`                             | Always OK: every publication includes a 404 page                                                                                                                            |
| `indexable_pages`                            | `sitewide_noindex` is off and more than one page can be indexed                                                                                                             |
| `orphan_pages`                               | Indexable pages that no other page, menu, template or listing links to                                                                                                      |
| `duplicate_titles`, `duplicate_descriptions` | Titles and descriptions shared by several pages, including pages that fall back to the site description                                                                     |
| `heading_h1`                                 | Each indexable page renders exactly one H1, counting the page, its template and the header and footer                                                                       |
| `long_descriptions`                          | Descriptions over 160 characters                                                                                                                                            |
| `duplicate_fonts`                            | Theme fonts loaded again by custom CSS or `scripts_head`                                                                                                                    |
| `custom_css_overrides`                       | Custom CSS findings from `lint_design_tokens`: heavy `!important` use, fonts not in the theme, a first-section background image set in CSS, rules on platform block classes |
| `ai_crawler_zone_conflict`                   | The Cloudflare zone's AI crawler settings against the site's `ai_crawler_policy`                                                                                            |
| `structured_data`                            | Page JSON-LD missing required properties (FAQPage, Article, Product, SoftwareApplication, Event, Recipe, Organization and similar) or with invalid dates or URLs            |

`ai_crawler_zone_conflict` reads the zone's bot settings only through the
organization's existing Cloudflare connection, and only when its token already
has Bot Management Read. Typeroll never asks for that permission for this
check and never changes zone settings. Without access, the item is a
suggestion that explains where to check in the Cloudflare dashboard. Blocking
Training in Cloudflare can also block Googlebot, Bingbot and Applebot, because
Cloudflare applies the strictest rule to crawlers that do several jobs.

## How customer publishing works

1. Typeroll freezes the selected Site Version and its saved content.
2. Generated source is committed to the Site's GitHub repository and version branch.
3. The Organization's selected shared build engine (Cloudflare or GitHub Actions)
   builds with pinned dependencies and the publication's media grants.
4. Finished static files, including referenced public media, go to Cloudflare
   Pages in the Site's Hosting Group account.
5. Typeroll verifies the public deployment before exposing its link.

Published and unlisted pages can be deployed. Draft and review pages are
excluded. Unlisted pages use `noindex`; non-main versions and default-domain
demos also remain out of search indexes. Build times depend on the content,
provider queue, dependencies and media work.

### One publication at a time per Organization

All Sites in an Organization share one build engine, and its runners take the
oldest task in the Organization. Publish one Site at a time: start the next
publication when the previous job has `succeeded` or `failed` and
`read_organization_build_engine` shows no `active_jobs`. Scripts read the same
status with an organization API key from `GET /api/v1/publishing/builds`; each
active job lists its `job_id` (a deploy id, or `media-…` for image preparation),
`site_id`, `kind` and `status`. A publication stays listed with status
`publishing` after its build, while its files upload and the public deployment
is verified, until its deploy reaches `succeeded` or `failed`. A domain switch
that is built and verified and only waits for DNS approval is listed under
`awaiting_approval` instead: it uses no build capacity and has released its
site's publishing lock, so other Sites may publish while it waits. Concurrent
publications at best queue; up to Core 0.2.132 they could fail each other with
`build_result_missing`. That code means the build engine stopped without
reporting a result: a runner never ran the task, and the content did not cause
it. Publish again once the engine is idle. `retry_deploy_verification` does not
apply to it, nor to other build failures; it only retries public verification
of an already-served publication.

Reported server-cost estimates cover only the publisher's own work in the
portal's runtime; they are not the customer's Cloudflare or GitHub invoice.

## Deploy URLs

New customer-publishing sites use the assigned Hosting Group's site address base
or their configured custom domain. They do not receive a permanent Typeroll
subdomain. The `main` version uses the live branch; other versions use
`version-<version-id>` branches and separate addresses.

A saved **Published** status is not a live-link guarantee. Wait for the job's
public availability verification. Use [Publishing](../../guides/customer-publishing/)
for setup and [Website and media domains](../../publishing/domains/) for domain changes.

Core 0.2.16 public probes do not require immediate deletion of retired versioned
Extension or hashed Astro CSS/JavaScript bundles, which Cloudflare may retain.
The exact candidate still checks their absence. Removed Pages/media and all
current files remain verified. See [verification and retired bundles](../../guides/customer-publishing/#verification-and-retired-static-bundles).

## `retry_deploy_verification`

From Core 0.2.39 / MCP 0.45.32, an admin can retry public verification of a
customer publication that timed out **after** its build and candidate checks
finished and its files reached the public host. In the site overview, choose
**Retry verification** beside the failed deployment. The server rejects
incomplete builds, newer deployments for the same version, changed hosting and
unrelated failure types. Correct the reported technical problem first.

The retry keeps the same job ID, saved source, Git commit and artifact. It checks
the real public marker and files, then updates CMS publication status only if
those checks pass. It does not build, upload, change DNS or publish later edits.
Poll `get_deploy_status` for the same job after requesting the retry.

```json
{ "job_id": "deployment-id", "version": "main" }
```

The equivalent authenticated API call is
`POST /api/v1/sites/{siteId}/deploy?version=main` with
`{ "retry_verification_job_id": "deployment-id" }`. Do not combine it with
`dry_run`. Requesting another retry while the same verification is running
returns the existing job; it does not start another verification chain.

### Recovering stale hosting cache

**Core 0.2.117 / MCP 0.45.88 (pending release):** retry also accepts
`publication_cache_refresh_required`, `publication_cache_refresh_external` and
`publication_cache_refresh_failed`. These describe a completed, already-served
build whose normal public URL still returns old bytes. Inspect `static_probe`
and `cache_recovery` in `get_deploy_status`; do not start a new build.

A domain preparation checks the files at the current address before it offers
the switch, the same way as a normal publication. Traffic and DNS stay unchanged.

**Core 0.2.157:** when a check finds an old file, Typeroll refreshes the cache for
that one path on that site's own hostname, observes it about a minute, and makes
at most three such refreshes per publication. It never refreshes another host
or a whole Cloudflare zone, and retry no longer accepts `approve_cache_zone_id`
(it is refused with `publication_cache_zone_refresh_retired`).

Cloudflare Pages keeps its own cache, keyed by the public URL, above your zone.
Zone purges of any scope cannot clear it, so a file removed from a publication
can keep answering at some Cloudflare locations until its cache lifetime ends.
Two cases follow:

- **A removed file whose name carries its content hash** (`/_assets/…-<hash>.ext`
  or `/media/<hash>-name.ext`) passes when the served bytes have exactly that
  hash and the same URL with a fresh cache key returns 404, which proves the
  deployment no longer contains it. The job lists such files in
  `retained_immutable` and `warnings`; no page shows changed content.
- **Anything else** that stays stale ends with `publication_cache_refresh_failed`.
  `cache_recovery.layer` says where: `upstream_cache` (the deployment is correct
  and a cache above the zone holds the old response), `origin` (the deployment
  itself still serves it) or `unknown`. `cache_recovery.cf_ray` identifies the
  observed response. Retry verification of the same job later; do not rebuild.
