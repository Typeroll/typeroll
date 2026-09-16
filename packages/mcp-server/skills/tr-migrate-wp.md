---
name: tr-migrate-wp
description: Use when the user asks to migrate a WordPress site to Typeroll, mentions wp-json, or names a WP source URL. Walks the WP REST API, preserves content and shared references in editable blocks, transfers media, sets redirects, leaves everything as drafts for human review.
---

# Migrate from WordPress to Typeroll

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks and partials) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


The platform's in-portal migration workflow is the "managed" path for
customers who want one-click. This skill is the "power-user" path: you
do it locally, mix data sources freely, and the user reviews each step in their terminal.

## Preconditions

**Run the readiness check FIRST — before touching any content:**

```
get_migration_readiness source_url="https://oldsite.com"
```

When the migration includes reusable page/item layouts, include each proposed
block composition and its content type fields in this same call. A
`waiting_for_native_support` result means leave that template intact and do
not replace the gap with generic custom blocks, raw HTML, or corrective site
CSS. Independent content and SEO work may continue. Rerun the review after the
required Core version is deployed, then verify preview and a fresh hosted
build.

Pass `source_url` — that adds the checks on the site you're migrating FROM.
An old host that answers 403/429 to server-side requests is a **blocker**: the
import would produce empty pages, or pages containing the host's block page,
which reads as real content and is worse. Whether `/wp-json` answers is a
warning, since scraping is a real fallback (it just loses ACF/custom fields).

If `ready` is false, STOP and report the blockers to the user. Do not start
the import "and fix it after": every blocker is one whose failure is invisible
once the work is done, so discovering it late means redoing the expensive part.

- **Media storage** — without it, every `<img>` keeps its WordPress URL. The
  new site looks perfect and is still served images by the old host. It breaks
  the day the customer cancels that hosting, months later, all at once.
- **Hosting adapter** — without credentials, deploys return a job id and
  publish nothing, while reporting success.

Warnings are worth relaying but don't stop you: no verification origin (the
pre-cutover parity check can't run), forms without a
notification address, or a target site with no design to rebuild INTO.

Then the ordinary preconditions:

- `@typeroll/mcp-server` configured with a valid `TYPEROLL_API_KEY`.
- The source WP site has `/wp-json` reachable (Google for "wordpress
  REST API disabled" if not — common for hardened hosts).
- The Typeroll target site exists **and already carries the design** —
  settings, header/footer, one or two example pages. Import preserves content; shared templates define presentation. Agree whether
  to preserve the original appearance or redesign it. Do not silently restyle
  or rewrite imported text.
- If the target already has content, you must NOT clobber it — always
  `list_pages` first and only write to slugs that don't already exist.

## Recipe

### 1. Probe and inventory

```
fetch <wp-url>/wp-json                           # confirm REST is on
fetch <wp-url>/wp-sitemap.xml or /sitemap.xml    # URL inventory
```

Build a list of every URL you intend to migrate. WP custom post types
need their REST endpoint (e.g. `/wp-json/wp/v2/news?per_page=100`),
walking `X-WP-TotalPages` to paginate.

### 2. Learn the target's design

```
get_site
read_site_settings                               # colors, fonts, voice cues
list_partials                                    # header / footer / shared
read_partial partial_id="header"                 # nav structure
list_pages limit=5
batch_read_pages page_ids=[<2-3 representative ids>]   # see actual conventions
```

Don't skip this. Imposing a stranger's design on a customer's site is
the biggest avoidable mistake.

### 3. Normalize shared data before importing page bodies

Read taxonomy definitions and paginated terms from the helper's `/taxonomies`
and `/terms/{taxonomy}` (Helper 0.3.2), or WordPress REST. Create a Content type
for each taxonomy and one Page per term. Preserve term IDs in a stable source
mapping, archive URLs, parents and custom fields such as icons/emoji.

Add `page_ref_list` fields to article Content types. Store term Page IDs, never
copied category names, emojis, slugs or sort values on every article. Category
archives can list articles using `core/repeater` with `source_type: backlinks`.
Use an explicit primary category for breadcrumbs when available; do not guess
among multiple categories. A table of contents is a derived template block,
not a `toc_html` field.

Category and tag Pages have editable block bodies. Scaffold the source term
description plus a reverse-reference listing, leaving room for unique editorial
content. Multiple tag/category references do not give a Page multiple parents:
preserve its source page parent, or use an unambiguous primary category. Tags do
not set its parent. `parent` controls breadcrumb ancestry, not URL generation;
preserve the source `path` even when it differs from the chosen hierarchy.

The managed importer preserves existing imported Pages on retry and refuses
URL/identity conflicts or dangling term references. An older flattened import
requires a separately reviewed mapping repair; do not re-import over edits.

### 4. Import one page at a time, draft status

For each source URL:

a. Fetch from WP. Prefer the helper plugin's authenticated endpoint
   (`/wp-json/typeroll/v1/...`) if available — it bypasses
   `show_in_rest=false` and returns ACF + builder fields. Otherwise
   fall back to `/wp-json/wp/v2/<post-type>?slug=<slug>`.

b. Clean the HTML. Strip Elementor / Gutenberg / Breakdance class
   soup. Drop empty `<div>` and `<span>` wrappers. Keep semantic tags,
   tables, iframes from known hosts (YouTube / Vimeo / Calendly).

c. Migrate referenced images with `upload_media_from_url`. The customer's
   transfer Worker copies and verifies them directly in R2. Use the returned
   media reference only after verification. Stop and report a failed required
   transfer; do not silently hotlink the WordPress source.

d. Preserve exact text, headings, anchors, links, media and semantic structure with native blocks first. Read the
   available block types and map headings, prose, images, buttons and layout
   into their typed fields. Use HTML mode only for source-specific markup that
   has no native representation and has passed the composition preflight.

e. Write the page as a draft:

   ```
   create_page title="..." slug="<last-path-segment>"
               path="/<preserved-wordpress/path/>"
               blocks=[<native block tree>]
               status="draft" kind="article" author="..."
               seo_title="..." seo_description="..."
   ```

   **Preserve the source URL.** WP post URLs like
   `/2024/01/foo-bar/` uses `slug: "foo-bar"` and
   `path: "/2024/01/foo-bar/"`. Slug is one segment; `path` preserves the
   complete nested URL.

### 5. Redirects

After migration, every URL the agent didn't preserve verbatim needs a
redirect:

```
create_redirect from_path="/old-services" to_path="/services"
```

Walk the inventory; for each URL: did it become a page with the same
path? If yes, no redirect. If renamed, `create_redirect`. If
intentionally dropped, mark it `excluded` via `update_migration_url` (the
customer should sign off on every dropped URL).

**Use wildcards for WordPress's URL families.** A WP site's dead URLs come in
shapes, not as individuals — and the inventory only knows the ones it found,
while the old site had more (paginated archives, feeds, attachment pages). One
pattern rule retires the whole family:

| WordPress shape | Rule |
|---|---|
| Intentionally retired category archives | `from_path="/category/*"` → `to_path="/blogg/:splat"` (or a single landing page) |
| Intentionally retired tag archives | `from_path="/tag/*"` → `to_path="/blogg"` |
| Author archives | `from_path="/author/*"` → `to_path="/om-oss"` |
| Date-based permalinks | `from_path="/2019/*"` → `to_path="/blogg/:splat"` — one rule per year |
| Old post prefix → new | `from_path="/blog/:slug"` → `to_path="/artiklar/:slug"` |
| Feeds | `from_path="/feed/*"` → `to_path="/blogg"` |

Rules:

- **Trailing `*` only.** A mid-path splat (`/blog/*/comments`) is dropped
  silently by Cloudflare — the platform refuses it at write time.
- **`:splat`** carries the captured remainder; **`:name`** matches exactly one
  segment and can be replayed by name.
- **A pattern that would hide a live page is refused**, naming the pages. That
  is the platform protecting you: redirects are applied before static files, so
  `/blogg/*` would make every real article under `/blogg/` unreachable. Narrow
  the prefix instead.
- **Query-string URLs can't be matched.** WP's `/?p=123` has no path to key on;
  those need handling at the source (or accept the loss and mark them excluded).
- Rules are emitted most-specific-first, so a narrow rule always beats a broad
  one — you can safely have `/blogg/recept/*` alongside `/blogg/*`.

Then verify against reality before anything is cut over:

```
import_sitemap url="https://old.example.com/sitemap.xml"
# Optional: direct Search Console query (platform service account must have property access)
import_gsc_performance property="https://old.example.com/" months=6
# Or paste a Search Console Pages CSV via csv="..." and source_origin.
check_internal_links         # database preflight before deploy
verify_migration_urls        # after trigger_deploy; compact exceptions by default
record_migration_seo_acceptance  # after reviewing this exact deployment
get_migration_launch_report      # final fail-closed launch gate
```

The inventory merges slash-equivalent URLs into one work item but preserves
their source spellings in `observed_paths`. Verification requests every one of
those spellings; treat a failing variant as a real gap even when coverage is
otherwise complete. Fresh builds expand redirect sources to both slash forms.

For a site imported before Typeroll normalized WordPress plain-text fields,
audit and repair the legacy records before visual review:

```
repair_migration_plain_text  # dry_run=true by default; returns exact field diffs
```

This operation is deliberately limited to `title`, `seo_title`,
`seo_description`, and schema-defined plain-text `excerpt` fields. It cannot
touch bodies, HTML, slugs, paths, or URLs. Show all returned diffs and
conflicts to the user. Only after explicit approval, repeat the same scope and
selectors with `dry_run=false save=true`. If `truncated=true`, narrow the
selection or raise `diff_limit` and review the omitted diffs first. Never work
around a `working_copy` conflict: that resource contains another edit which
must be resolved separately.

### 6. Preview + review with the user

```
get_preview_link page_id=<id>                    # one URL the user can click
```

Compare the source and target at desktop and mobile widths. Review representative
articles, an archive and the home page. Measure heading sizes, readable width,
spacing, TOC placement and image/card proportions. Scroll below the fold: verify
headings after media, the TOC below a sticky header, anchor landing positions
and related articles inside the intended content column. In Core 0.2.7+, use
`rhythm: "article"` on the Page content slot and `appearance: "card"` on Post
Cards for these native presentation choices; no per-page corrective CSS. Check breadcrumbs and shared
category references; test forms/Extensions. HTTP 200 and text presence do not
prove visual fidelity. Document intentional improvements such as responsive video.

Record `fidelity: { desktop, mobile, shared_data, integrations, evidence }` with
`record_migration_seo_acceptance`, based on real checks of the exact deployment.
The launch report requires this evidence in Core 0.2.5.
Never mark an unavailable integration or uninspected screenshot as accepted.

### 7. Ship

When the user signs off:

```
# Bulk-publish drafts that look right
batch_update_pages updates=[{page_id, patch:{status:"published"}}, ...]

# Deploy
trigger_deploy
get_deploy_status job_id=<id>    # poll
```

## Pitfalls

- **Don't publish during migration.** Always import as `draft`. Even
  if the agent is confident, the customer needs the chance to spot-check.
- **WP slugs sometimes drift.** A post saved with slug `foo-bar` may
  have been served at `/2024/01/foo-bar/` due to the permalink
  structure. The full URL is what users see in Google; preserve that,
  not the bare slug.
- **Image bandwidth.** R2 upload is metered. Use `find_pages_matching`
  contains="<old-domain>" on already-imported content to spot images
  that weren't transferred.
- **WP-specific JSON-LD** (Yoast, Rank Math) is usually wrong after a
  redesign because it references old URLs. Strip it; let Typeroll
  emit fresh Article/Page schemas via `kind: 'article'` + `author`.

## When the source isn't WordPress

The same shape applies for any source — Squarespace export, custom
CMS, scraped HTML, CSV. Replace step 1's "WP REST" probe with whatever
discovery the source supports, and the rest of the recipe is unchanged.

## Storage prerequisite

Before reading or importing source content, call `get_import_readiness` (Core
0.1.95 / MCP 0.44.68 or later). If `ready` is false, stop the import and show the
returned message and Publishing settings link. The organization must connect
and verify its own storage first. Do not fall back to draft storage, hotlink
source images, or use ordinary page-write tools to bypass the import gate.
Use `upload_media_from_url` for referenced source images; the customer’s
Cloudflare transfer Worker copies and verifies them directly in R2, independently
of the GitHub/Cloudflare build-provider choice.
