---
title: Deploy Tools
description: Build and deploy your static site to Cloudflare Pages.
---

## `trigger_deploy`

Starts a new deploy. Returns a `job_id` that Claude uses to track progress.

```
Deploy the site.
```

Claude calls this automatically at the end of most tasks. You can also say "deploy" at any time.

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

Polls the deploy job for status. Claude calls this in a loop until the deploy completes or fails.

Possible statuses:

- `queued` — waiting to start
- `running` — build in progress (~30–90 seconds for most sites)
- `succeeded` — deployed successfully
- `failed` — build error (Claude will report what went wrong)

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
[Self-Hosting](/guides/self-hosting/).

## `get_preview_link`

Returns a signed preview URL for the current site state — without deploying. Use this to review changes before they go live.

```
Show me a preview of the site.
```

The preview link is valid for 24 hours and reflects the current draft state, not the last deploy.

## How deploys work

1. The portal materialises all site content into a temporary directory
2. Astro builds the static site from that content (~30–90s)
3. The output is uploaded to Cloudflare Pages
4. The Cloudflare CDN serves the new version globally within seconds

Only `status: "published"` pages are included in the build. Draft and review pages are excluded.

## Deploy URLs

After a successful deploy, Claude reports the site URL:

- Typeroll subdomain: `https://your-site.sites.typeroll.com`
- Custom domain (if configured): `https://yourdomain.com`

Both URLs update with every deploy.
