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

### Dry runs

Pass `dry_run: true` to build without publishing. The full build runs —
content is materialised, Astro renders every page, assets are bundled — but the
output never leaves the server and your live site is untouched.

```
Build the site but don't publish it — I just want to know it compiles.
```

Use it to check that a structural change (a new collection, a schema edit, a
template rewrite) actually builds before it reaches visitors. The job is
reported as `succeeded` with `dry_run: true` and no `deploy_url`.

## `get_deploy_status`

Polls the deploy job for status. The AI agent calls this in a loop until the deploy completes or fails.

Possible statuses:

- `queued` — waiting to start
- `running` — build or distribution in progress
- `succeeded` — deployed successfully
- `failed` — build error (the AI agent will report what went wrong)

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
see unsaved drafts; that choice is signed into the link.

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

Legacy managed and self-hosted publishing can execute builds in the portal's
configured runtime. Reported server-cost estimates describe that runtime; they
are not the customer's Cloudflare or GitHub invoice.

## Deploy URLs

New customer-publishing sites use the assigned Hosting Group's site address base
or their configured custom domain. They do not receive a permanent Typeroll
subdomain. The `main` version uses the live branch; other versions use
`version-<version-id>` branches and separate addresses.

A saved **Published** status is not a live-link guarantee. Wait for the job's
public availability verification. Use [Publishing](../../guides/customer-publishing/)
for setup and [Website and media domains](../../publishing/domains/) for domain changes.
