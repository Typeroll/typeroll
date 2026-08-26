---
title: Migration URL Tools
description: Track every URL the old site had, and prove the new one answers before you switch DNS.
---

When you move an existing site to Typeroll, the risk isn't the content — it's the URLs. Every address that Google, a bookmark or another site's link points at has to keep working, or you lose the traffic that was already yours.

Typeroll keeps a **URL inventory** per site for exactly this, and Claude can read and write it.

## Before anything else: readiness

> "Is this site ready to receive the migration?"

Claude calls `get_migration_readiness` first. It checks the things whose absence you would otherwise discover months later:

| Check             | Why it blocks                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Media storage** | Without it, imported pages keep their original image URLs. The new site looks perfect and is still being served images by the old host — invisible until that hosting is cancelled, when every image breaks at once. |
| **Hosting**       | Without credentials, deploys return a job id and publish nothing, while reporting success.                                                                                                                           |
| **The old site**  | If the host refuses our requests (bot protection, an IP allowlist, HTTP auth on a staging copy), the import produces empty pages — or pages containing the block page, which reads as real content.                  |

Warnings don't stop the job but are worth knowing: no verification URL for the pre-cutover check, no AI reconstruction, forms with no notification address, or a target site with no design for the content to be rebuilt into.

If it isn't ready, fix the blockers before starting. The content work is the expensive part of a migration, and every blocker above means doing it twice.

## The two questions

They sound the same and they are not:

| Question                                      | Tool                    |
| --------------------------------------------- | ----------------------- |
| "Is every old URL accounted for in our data?" | `list_migration_urls`   |
| "Does the new site actually answer them?"     | `verify_migration_urls` |

The first classifies each inventory entry against the site's current pages and redirects. The second **requests every URL** against the deployed site and reports what came back. They disagree exactly when it matters — a redirect pointing at a page that was never published, a typo in a path, a redirect loop. All of those look handled in the data and return a 404 to a visitor.

## `list_migration_urls`

Returns the inventory with a live coverage status per entry:

- `migrated` — a page or collection item answers at that path
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

> "The old campaign landing pages are gone on purpose — mark them excluded with a note."

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

## Where this fits

For a single WordPress site, the portal's migration workflow builds the inventory for you. For anything else — a Squarespace site, a static export, or a whole family of sites moving together — Claude populates it with `add_migration_urls` and works the list down to zero.

For a multi-site or multi-domain move, ask Claude to read the `tr-migrate-multisite` skill first.
