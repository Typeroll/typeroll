---
title: Migration URL Tools
description: Track every URL the old site had, and prove the new one answers before you switch DNS.
---

These tools wrap `/api/v1/sites/{siteId}/migration-urls`, with `/import-sitemap` and `/import-gsc` for bulk import.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

When you move an existing site to Typeroll, the risk isn't the content — it's the URLs. Every address that Google, a bookmark or another site's link points at has to keep working, or you lose the traffic that was already yours.

Typeroll keeps a **URL inventory** per site for exactly this, and the AI agent can read and write it.

## Before anything else: readiness

> "Is this site ready to receive the migration?"

The AI agent calls `get_migration_readiness` first. It checks the things whose absence you would otherwise discover months later:

| Check             | Why it blocks                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Media storage** | Without it, imported pages keep their original image URLs. The new site looks perfect and is still being served images by the old host — invisible until that hosting is cancelled, when every image breaks at once.                              |
| **Publishing**    | With verified Organization storage, customer publishing can import and preview before GitHub, builds or domains are connected. Legacy self-hosted setups may still report a missing hosting adapter. Publication readiness is checked separately. |
| **The old site**  | If the host refuses our requests (bot protection, an IP allowlist, HTTP auth on a staging copy), the import produces empty pages — or pages containing the block page, which reads as real content.                                               |

Warnings don't stop the job but are worth knowing: no verification URL for the pre-cutover check, forms with no notification address, or a target site with no design for the content to be rebuilt into.

If it isn't ready, fix the blockers before starting. The content work is the expensive part of a migration, and every blocker above means doing it twice.

## The four independent questions

They sound the same and they are not:

| Question                                           | Tool                              |
| -------------------------------------------------- | --------------------------------- |
| "Is every old URL accounted for in our data?"      | `list_migration_urls`             |
| "Are saved internal links intact?"                 | `check_internal_links`            |
| "Does this exact deployment answer every variant?" | `verify_migration_urls`           |
| "Was content and SEO parity reviewed?"             | `record_migration_seo_acceptance` |

The first classifies each inventory entry against the site's current pages and redirects. The second **requests every URL** against the deployed site and reports what came back. They disagree exactly when it matters — a redirect pointing at a page that was never published, a typo in a path, a redirect loop. All of those look handled in the data and return a 404 to a visitor.

## `list_migration_urls`

Returns the inventory with a live coverage status per entry:

- `migrated` — a Page answers at that path
- `redirected` — a redirect rule covers it
- `excluded` — you decided it should 404
- `unhandled` — nothing covers it yet; this is the work list

Status is recomputed on every read, so it's never stale: create a redirect and the entry flips on the next call.

> "Show me everything from the old site that still isn't handled."

## `add_migration_urls`

Populates the inventory in bulk — from the old sitemap, a Search Console export, or a crawl. Re-adding a known URL merges it rather than duplicating.

> "Read https://oldsite.com/sitemap.xml and add every URL to the inventory."

Pass Search Console click counts along with the URLs and the coverage report sorts itself: the addresses carrying real traffic rise to the top of the work list.

**Migrating several sites at once?** Always give the source origin. Two markets both have a `/kontakt`, and without the origin guard one site's URLs can silently register as another's coverage.

## `update_migration_url`

Marks an entry `excluded` — the record that a URL is _meant_ to disappear. This is what distinguishes "we haven't looked at it" from "we decided", which is the whole value of the report.

> "Exclude these private source-admin/session URLs with a reason. Keep public campaign pages working or redirect them to relevant replacement content."

The preserve/renew migration contract requires continuity for every old public
URL. The API still supports intentional retirement, but using it for public
content needs a separately agreed exception; exclusion is not a shortcut to
launch readiness.

## `repair_migration_plain_text`

Older WordPress imports can contain encoded entities or HTML tags in fields
that should be plain text. This tool decodes exactly one entity layer and
removes markup, but only from `title`, `seo_title`, `seo_description`, and
schema-defined plain-text `excerpt` fields. It cannot change rich content,
HTML, slugs, paths, or URLs.

It defaults to a dry run and returns exact before/after diffs. Review all of
them before running it again with `dry_run: false`. Use `save: false` to create
working copies for portal review, or `save: true` to commit through the normal
revision path. A resource with an existing working copy is reported as a
conflict and left untouched.

> "Audit legacy WordPress titles and SEO text, then show me every proposed change."

## `verify_migration_urls`

The pre-cutover check. Requests every inventory URL against the deployed site and classifies the response:

| Verdict           | Meaning                                      |
| ----------------- | -------------------------------------------- |
| `ok`              | 200 at the same path — the URL was preserved |
| `ok_redirect`     | redirects to a page that answers             |
| `missing`         | 404 or 410 — this URL will break             |
| `broken_redirect` | a loop, or a chain ending badly              |
| `error`           | 5xx or timeout — inconclusive, run it again  |

By default it tests the site's fallback subdomain, which is the right target **while your real domain still points at the old host**. That's the point: you find and fix the gaps before anything is switched over, with the old site still serving.

It also stamps verification onto the redirect rules it exercised, so you can see which ones have actually been proven to work.

> "Deploy, then check every old URL against the new site and tell me what would break."

Deploy first — the check tests published, deployed content, not unsaved drafts.

A complete, unfiltered run stores compact evidence for the launch report. It
records the target origin, check time, expected request count (including slash
variants), and the latest successful non-dry-run deploy job. Filtered or
truncated runs never replace this evidence.

## `record_migration_seo_acceptance`

Records the result of a human- or tool-reviewed content/SEO comparison. It does
not pretend to run that comparison. Supply the source and target origins,
dataset description, checked page count, timestamp, and counts for intentional
and unresolved differences. Accepted evidence requires zero unresolved
differences and is bound server-side to the latest successful hosted deploy.

## `get_migration_launch_report`

This is the final, fail-closed launch gate. It reports inventory coverage,
exclusions without reasons, saved-link integrity, the exact hosted deployment,
deployed URL parity, untested URL variants, and reviewed content/SEO parity as
separate sections.

`launch_ready` remains false when any section is absent or failed. A new deploy
also makes both URL and SEO evidence stale, even if the content appears
unchanged; rerun the checks against that deployment. This prevents “zero
unhandled URLs” from being mistaken for proof that a migration is safe to
launch.

## Where this fits

For a single WordPress site, the portal's migration workflow builds the inventory for you. For anything else — a Squarespace site, a static export, or a whole family of sites moving together — the AI agent populates it with `add_migration_urls` and works the list down to zero.

For a multi-site or multi-domain move, ask the AI agent to read the `tr-migrate-multisite` skill first.

### Migration fidelity

Core 0.2.5 also requires fidelity evidence for a ready
launch report. `record_migration_seo_acceptance` accepts
`fidelity: { desktop, mobile, shared_data, integrations, evidence }`.
The four checks must be true, with a nonempty description of the chosen intent
and comparison: source fidelity for preserve, approved design/content for renew.
Record approved changes as intentional differences, not unresolved regressions. Review representative articles, an archive and the home
page where applicable; document intentional differences. This records an actual
review, not an automated visual test. Missing evidence reports
`fidelity_review_missing`, even if HTTP and SEO checks succeeded.

## Reviewed migration compositions

`get_migration_readiness` accepts `compositions` for a read-only block/field
review. Choose [separate text and design/image choices](../../guides/migration-approach/) in the project
brief; these intent labels are not migration API parameters.

After reviewing standard-block alternatives, record an intentional custom type
or exceptional HTML fragment on the composition:

```json
{
  "name": "Article with an art-directed hero",
  "blocks": [],
  "reviewed_custom_block_types": [
    {
      "type": "layered_hero",
      "reason": "Responsive layered hero with editable title, image and CTA; prototype reviewed."
    }
  ],
  "reviewed_html_blocks": [
    {
      "block_id": "one-off-artwork",
      "reason": "Unique layered hero animation; standard and custom alternatives reviewed, reduced motion and breakpoints tested."
    }
  ]
}
```

Supply the actual proposed block tree instead of the empty example `blocks`.
Each review list accepts up to 100 entries. Names/IDs and reasons must be nonempty;
reasons allow up to 2,000 characters. HTML exceptions match an exact block ID,
not every HTML block. The response retains them in `reviewed_exceptions`.
Missing types, missing declared fields, unreviewed workarounds and per-instance
CSS remain blockers. Reviews attest a decision; they do not establish visual
quality, recursively validate custom implementations or authorize publishing.
Validate custom types separately and inspect preview and static output.

**Availability:** these review fields require Core **0.2.89** / MCP **0.45.69**.
Cloud availability follows its Core rollout. Older installations do not accept
them; inspect the deployed tool
schema before calling. Standard block and URL verification tools are unchanged.
