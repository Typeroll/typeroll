---
name: tr-migrate-multisite
description: Use when migrating SEVERAL sites at once — a WordPress multisite network, a group of country/language sites on different top-level domains, or any batch of related sites moving to Typeroll together. Triggers on "multisite", "network of sites", "10 sites", "our .se/.de/.co.uk sites", "language versions", "migrate all our sites". For a single WordPress site use tr-migrate-wp; for a single non-WP source use tr-import-url.
---

# Migrate a multisite / multi-domain family to Typeroll

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.

## The first decision: one site or many?

**One Typeroll site owns exactly one domain** (plus its apex/www sibling).
So:

| The old family looks like | Build it as |
|---|---|
| `example.se`, `example.de`, `example.co.uk` — separate domains | **N Typeroll sites**, one per domain |
| `example.com/se/`, `example.com/de/` — one domain, language folders | **One site**, using `path` on each page (`/se/om-oss`) |
| A WP multisite on subdomains that the customer wants to consolidate onto one domain | **One site** + redirects from every old subdomain |

Confirm this with the user before creating anything — it's the one decision
that is expensive to reverse (domains, deploys, and analytics all hang off
it). The rest of this recipe assumes the common case: **N sites, one per
domain**, sharing a design.

Requires an **org-scoped API key** (`create_site` needs it, and one key
reaching every site is the whole point here). With MCP you pass `site_id`
per call; over stdio you'll be re-pointing `TYPEROLL_SITE_ID` per site.

## Phase 0 — Plan the batch (do this once, in writing)

Produce a table and get the user to confirm it before touching the platform:

| Old URL | Language | New Typeroll site | Domain | Notes |
|---|---|---|---|---|

**Check platform readiness before the plan is even agreed:**

```
get_migration_readiness site_id=<any existing site>
```

Then once per market, with that market's own source:

```
get_migration_readiness site_id=<de-site> source_url="https://example.de"
```

The blockers (media storage, hosting credentials) are **platform-level, not
per-site** — if they fail for one site they fail for all ten, and finding out
after building three sites means redoing three sites' worth of image work.
Get them fixed before Phase 1, and re-run the check per site once the sites
exist (the warnings — verification URL, form email, design reference — are
per-site).

Ask explicitly:
- Which site is the **design reference**? Build that one properly first.
- Are the sites **translations of each other** (same page structure) or
  independent? This decides whether hreflang clusters are mechanical or
  hand-mapped.
- Any domains being **retired or merged**? Those need redirects at the DNS
  level, not just inside a site.

## Phase 1 — Inventory EVERY old site, before building anything

Do this for all sites up front. It's cheap, it's the only artefact that tells
you when you're done, and it stops you discovering an untouched 400-URL blog
in week three.

For each source site, create the target site first (the inventory lives on
it):

```
create_site name="Example DE" domain="example.de"
```

Then walk the source and post what you find:

```
fetch https://example.de/sitemap.xml            # follow sitemap-index children
fetch https://example.de/wp-json/wp/v2/pages?per_page=100   # walk X-WP-TotalPages
```

```
add_migration_urls site_id=<de-site> source_origin="https://example.de" source="sitemap" urls=[
  { url: "https://example.de/ueber-uns" },
  { url: "https://example.de/kontakt" },
  …
]
```

**`source_origin` is not optional in a multisite job.** It rejects URLs from
another origin, which is the guard that stops domain B's `/kontakt` landing
in domain A's inventory — where it would silently read as "covered" because
domain A happens to have a `/kontakt` too.

Add every source you have, each with its own label — they merge per URL:
- `source="sitemap"` — the sitemap(s)
- `source="rest"` — WP REST pages/posts/custom types
- `source="gsc"` — a Search Console export, **with `gsc_clicks`**. This is
  what makes the coverage report prioritise itself: the 12 URLs carrying all
  the traffic sort to the top.
- `source="crawl"` — anything you found by following internal links

Mark the obvious throwaways immediately, so the work list is real:

```
add_migration_urls urls=[{ url: "/wp-admin", excluded: true }, { url: "/tag/nyheter", excluded: true }]
```

Read it back and note the starting number:

```
list_migration_urls site_id=<de-site> status="unhandled" limit=50
```

## Phase 2 — Build the reference site

Follow `tr-migrate-wp` (or `tr-import-url`) for the ONE reference site:
design, header/footer partials, page templates, block types. Get the user to
approve it before replicating — every fix you make after this point costs
N times as much.

## Phase 3 — Replicate the design to the other sites

Design travels as a block-type package, not by hand:

```
export_block_types site_id=<reference>                 # → .tcblocks JSON
import_block_types site_id=<other> package=<that JSON>
```

Then per site:
- `read_site_settings` on the reference → `update_site_settings` on the
  target with the same colors/fonts (translate `site_name`, `tagline`,
  contact details — those are per-market, not shared).
- Recreate header/footer partials with translated nav labels.
- Page templates: rebuild with `add_block target={kind:'template', id:…}`.

Set the language per site — it drives `<html lang>`, `og:locale` and
alt-text generation:

```
update_site site_id=<de-site> language="de"
```

## Phase 4 — Migrate content, preserving paths

Per site, per URL, follow `tr-migrate-wp` §3. Two rules that matter more here
than in a single-site migration:

1. **Preserve the path verbatim** unless there's a reason not to. Use
   `path` for anything nested: `create_page title="Über uns" slug="ueber-uns"
   path="/ueber-uns"`. A preserved path needs no redirect and loses nothing.
2. **Rewrite internal links to the NEW paths.** Imported HTML is full of
   absolute links to the old domain. Sweep them per site:

```
bulk_replace_text site_id=<de-site> find="https://example.de/" replace="/" dry_run=true
```

Check the dry-run count against what you expect before running it for real.
Cross-domain links between sister sites stay absolute — only the site's own
domain becomes relative.

### Media: per site, not shared

Every Typeroll site has its own media library, so a shared asset (the group
logo, a product shot used in all markets) is uploaded once **per site** and
gets a different CDN URL in each. That's correct — the sites are independent
and one market's deploy must not depend on another's assets — but it means:

- Don't try to reuse a `cdn_url` from site A inside site B's HTML. It will
  render, and it will break the day site A is deleted or moved.
- Do write alt text per market, in that market's language:
  `update_media media_id=… alt_text="…"`. The alt text is content, not
  metadata, and a Swedish alt on a German page is a real accessibility defect.

Images referenced only from a stylesheet or from unrendered page-builder JSON
are NOT found by an HTML scan. Spot-check the hero/background images of the
top pages in the preview before you call a site done.

### Forms are NOT migrated — plan to rebuild them

The HTML cleaner strips `<form>`, `<input>`, `<select>` and `<button>`
entirely, on purpose: a Contact Form 7 / Gravity / Elementor form posts to
WordPress endpoints that no longer exist, so importing the markup would give
you a form that looks alive and silently drops every submission.

So, per site:

```
create_form name="Kontakt" fields=[…]         # or steps=[…] for a funnel
add_block target={kind:'page', id:'kontakt'} block={type:'core/form', data:{form_id:'<id>'}}
```

Then, still per site:

- **Recipient address per market** — the German enquiries rarely go to the
  Swedish inbox. Check this explicitly; it is the single most common thing
  to get wrong in a batch of ten.
- **Email delivery is configured per site** by an admin in the portal
  (Settings → Integrations), not through this API. Flag it to the user as a
  manual step — a form that saves submissions but sends no notification looks
  fine in testing and loses leads in production.
- **Submit a real test through every form** after deploy, and confirm both the
  stored submission and the notification email.

Count the old site's forms during Phase 1 and put them in the plan table.
Ten sites × three forms is thirty forms, and it is the part of the job that
never shows up in a URL inventory.

## Phase 5 — Redirects for everything you didn't preserve

Work the coverage report, not your memory:

```
list_migration_urls site_id=<de-site> status="unhandled"
```

For each entry, one of three outcomes — no fourth option:

- It moved → `create_redirect from_path="/alte-seite" to_path="/neue-seite"`
- It's gone on purpose → `update_migration_url url_id=… excluded=true notes="Old campaign LP, signed off by <name>"`
- It should exist and doesn't → go back and migrate it

Re-read the list. `unhandled` reaching zero is the exit condition for this
phase.

**Clear the URL families with one rule each**, per site — a WP network
multiplies the same dead shapes across every market:

```
create_redirect site_id=<de-site> from_path="/category/*" to_path="/blogg/:splat"
create_redirect site_id=<de-site> from_path="/tag/*"      to_path="/blogg"
create_redirect site_id=<de-site> from_path="/2019/*"     to_path="/blogg/:splat"
```

Only a TRAILING `*` is supported (`:splat` replays the remainder); `:name`
matches one segment. Pattern-covered inventory URLs count as `redirected`, so
the work list actually empties. A pattern that would hide a live page is
refused, naming the pages — narrow the prefix rather than working around it.

Watch the per-market prefixes: the German site's archive base is `/kategorie/`,
not `/category/`. Write the rules from each site's own inventory, never by
copying the reference site's.

## Phase 6 — Wire the hreflang cluster

This is the step that only exists because the family is multi-domain, and the
one most likely to be skipped. Each page declares its siblings on the other
domains; the renderer adds the page's own self-reference.

```
update_page site_id=<se-site> page_id="om-oss" patch={ alternates: [
  { hreflang: "de", href: "https://example.de/ueber-uns" },
  { hreflang: "en-GB", href: "https://example.co.uk/about-us" },
  { hreflang: "x-default", href: "https://example.com/about-us" }
]}
```

Rules the search engines actually enforce:
- **Reciprocal.** Every page in a cluster must list every other one. Write
  all N sides or the cluster is ignored. `batch_update_pages` is the sane way
  to do this once you have the mapping table.
- **One `x-default`** per cluster, pointing at the language selector or the
  fallback market. Optional, but useful when the family doesn't cover a
  visitor's language.
- **Absolute URLs on the final domain** — not the `*.typeroll` fallback
  subdomain. The cluster is what you want live after cutover, and a fallback
  URL in there is a leak you'll be cleaning up for months.
- Invalid entries are **rejected at write time** with the reason. If a write
  fails, fix the tag/href — don't strip the field to make it pass.

Pages that have no equivalent on the other domains get no alternates at all.
A cluster of one is meaningless markup.

## Phase 7 — Verify BEFORE touching DNS

Deploy each site (`trigger_deploy`), then check what it actually serves:

```
verify_migration_urls site_id=<de-site> source_origin="https://example.de" check_source=true
```

This requests every inventory URL against the site's fallback subdomain —
the real domain still points at the old host, which is exactly why the check
is possible at all. Verdicts:

| Verdict | Meaning | Action |
|---|---|---|
| `ok` | 200 at the same path | none |
| `ok_redirect` | redirects to a 200 | none; flatten if `hops` > 1 |
| `missing` | 404/410 | **the gap** — redirect it or migrate it |
| `broken_redirect` | loop, or chain ending on an error | fix the rule |
| `error` | 5xx / timeout | inconclusive, re-run |

`check_source=true` also requests the OLD site, so a URL that already 404s
upstream shows up as noise in the inventory rather than as a migration
failure — mark those `excluded`.

Note what the check does NOT catch: it verifies that a URL *resolves*, not
that the page at the other end is the right content. Spot-check the top
`gsc_clicks` URLs by eye.

Iterate until `missing` and `broken_redirect` are both zero **on every site**.
Then, per site:

1. `add_domain` / follow the DNS instructions the platform returns
2. Point DNS
3. `poll_domain` until verified → `activate_domain`
4. Re-run `verify_migration_urls target_origin="https://example.de"` against
   the real domain, to confirm the cutover kept what the pre-check proved
5. Submit the new sitemap in Search Console; keep the old property open for
   a few weeks and watch the 404 report

## Definition of done (per site)

- [ ] `get_migration_readiness source_url=<this market's old site>` → `ready: true`, warnings reviewed
- [ ] `list_migration_urls status="unhandled"` → 0
- [ ] `verify_migration_urls` → 0 `missing`, 0 `broken_redirect`
- [ ] hreflang cluster written on both/all sides, absolute, final domains
- [ ] `language` set on the site; `<html lang>` correct in the deployed HTML
- [ ] Internal links rewritten (no lingering absolute links to the old domain)
- [ ] Forms rebuilt, recipient address correct for THIS market, test submission sent and received
- [ ] Media uploaded to this site's own library (no cross-site `cdn_url`), alt text in this market's language
- [ ] Domain verified + activated; sitemap submitted

## Pitfalls specific to this job

- **Don't share one inventory across domains.** Inventory entries key on
  path; two markets both have `/kontakt`. One site, one inventory.
- **Don't build all N sites in parallel from scratch.** Build one, approve,
  replicate. Parallel building multiplies every design mistake by N.
- **Don't skip the parity check because coverage says 100%.** Coverage is a
  claim about the data; parity is a measurement of the server. They disagree
  exactly when it matters — an unpublished target page, a typo'd path, a
  redirect chain.
- **Don't point DNS site-by-site on a whim.** Cutting over one market at a
  time is fine and usually wise, but the hreflang cluster spans markets: a
  page pointing at a domain that still serves the old site is pointing at
  content that doesn't match. Either cut over close together, or write the
  cluster after the last market lands.
