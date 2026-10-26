---
name: tr-migrate-wp
description: Use when the user asks to migrate a WordPress site to Typeroll, mentions wp-json, or names a WP source URL. Walks the WP REST API, preserves cleaned HTML and shared references, transfers media, sets redirects, and leaves everything as drafts for human review. Typeroll does not convert HTML into blocks.
---

# Migrate from WordPress to Typeroll

**Who runs this:** this recipe is for the user's own AI agent (Claude Code, Codex or
another MCP client) working through MCP and the public API. The portal's built-in
AI assistant has no migration tools: it does not import, convert or verify sites.

**Before import or reconstruction:** read `tr-migration-evidence` with
`read_skill`. Choose preserve or renew independently for text and design/images,
record text_intent and design_intent in the brief and verify one prototype per active template before bulk writes.
Use standard blocks first, reviewed custom types next, rare documented HTML last.
All four combinations must preserve or meaningfully redirect every old public URL. That
shared contract defines acceptance; this recipe only adds source-specific steps.


> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks and partials) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


The platform's migration workflow is the "managed" path for customers who
want one-click. It runs on the server and is also available to you:
`start_workflow type="migration" config={ wp_url }` on an existing site, or
`create_site_and_migrate` (organization key) for a new one; poll `get_workflow`
and approve its review gate only with the user's consent. This skill is the
"power-user" path: you do it locally, mix data sources freely, and the user
reviews each step in their terminal.

## Site tokens before block overrides

Core 0.2.106 / template capabilities 0.54.0 adds palette names in all colour
fields and named typography/spacing steps. Check the connected capability
version; on older renderers use `var(--color-surface)` rather than a bare name.

Set colours and font families in site settings, then use named styles and
palette names in blocks. Do not write hex, rgb or font-family literals in block
content. Prefer `primary`, `secondary`, `accent`, `background`, `surface`, `text`,
`text_light`, and `on_primary`/`on_secondary`/`on_accent` for text on brand colours.
Use `surface_hover` for a darker interactive surface (derived automatically
unless explicitly configured). Existing semantic roles should be reused; a
new visual shade is not automatically a new semantic role. For a derived shade
use `color-mix(in srgb, var(--color-surface) 92%, var(--color-primary))`.
For an additional role not in the native palette, define a named site style
or a site CSS variable derived from existing palette variables, and document it.

Choose `heading`, `body` or `mono` for fonts. Font families belong only in the
site's `fonts` settings. Use type-size steps `xs`, `sm`, `md`, `lg`, `xl`, `2xl`,
`3xl`; spacing `none`, `xs`, `sm`, `md`, `lg`, `xl`; line height `tight`, `snug`,
`normal`, `relaxed`, `loose`. Presentation fields accept responsive maps of these
names, for example `font_size_px: {mobile: "md", desktop: "lg"}`. Read the field
schema: counts, widths and breakpoints are not spacing steps. Pixel values are
explicit exceptions, not the default authoring method. Configure scales in
`design_scales`, then reuse them in role styles and blocks.

Record deliberate exceptions in `decisions.md`, with source/block, reason and
review criteria (for example white text on a photograph). Run `lint_design_tokens`
before launch and after major design changes. It warns, never blocks launch.
Use the starter's `scripts/typeroll/color_tokens.py` for an exact-match dry run;
review the plan before applying it in a dedicated Version. Equal hex values can
mean different roles: never automatically choose between background and text.
Verify a primary/surface change in a test Version across header, footer, cards,
menus and buttons, then restore the test settings. Do not republish automatically.



## Preconditions

**Run the readiness check FIRST — before touching any content:**

```
get_migration_readiness source_url="https://oldsite.com"
```

When the migration includes reusable page/item layouts, include each proposed
block composition and its content type fields in this same call. A
`waiting_for_native_support` result means inspect the actual blocker. Review
intentional custom types and rare HTML exceptions using `tr-migration-evidence`;
fix missing types/fields and report renderer defects rather than masking them. Independent content and SEO work may continue. Rerun the review after the
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
- **Publishing** — with verified Organization storage, customer publishing can
  import and preview before GitHub, builds or website domains are connected.
  Publishing readiness is a separate gate before a hosted build/cutover. Legacy
  self-hosted configurations may report a missing hosting adapter; follow the
  returned blocker rather than assuming all installations have the same setup.

Warnings are worth relaying but don't stop you: no verification origin (the
pre-cutover parity check can't run), forms without a
notification address, or a target site with no design to rebuild INTO.

Then the ordinary preconditions:

- MCP connected through personal OAuth or an appropriately scoped API key.
  Select and confirm the Site/Version before writes; do not request pasted secrets.
- The source WP site has `/wp-json` reachable (Google for "wordpress
  REST API disabled" if not — common for hardened hosts).
- The target exists. Establish the source design baseline first, then prove
  representative target templates using `tr-migration-evidence`. Preserve
  appearance when design_intent is preserve; use the approved design brief when it is renew. Review text against its separate choice.
- If the target already has content, you must NOT clobber it — always
  `list_pages` first and only write to slugs that don't already exist.
  Pass the slug explicitly: `create_page` then refuses an address that is
  already in use (409 `slug_in_use` naming the existing page) instead of
  numbering it.

## Recipe

### 1. Probe and inventory

```
fetch <wp-url>/wp-json                           # confirm REST is on
fetch <wp-url>/wp-sitemap.xml or /sitemap.xml    # URL inventory
```

Build a list of every URL you intend to migrate. WP custom post types
need their REST endpoint (e.g. `/wp-json/wp/v2/news?per_page=100`),
walking `X-WP-TotalPages` to paginate.

### 2. Measure the source and protect existing target work

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

**Styles.** Recurring source treatments (theme classes for eyebrows, leads,
button variants, highlighted sections) become named site styles
(`create_style`) applied with `style_id`, so editors can change them in one
place. Do not preserve them as classed raw HTML in text blocks.

### 4. Import one page at a time, draft status

For each source URL:

a. Choose access based on missing evidence, not a mandatory plugin install:

   | Source requirement | Access path |
   | --- | --- |
   | Public Pages, posts, media and rendered builder content exposed in REST | Public paginated `/wp-json/wp/v2/pages`, `/posts`, `/media` and rendered HTML can suffice |
   | SEO exposed in `yoast_head_json`, visible menus/backgrounds | Public REST + rendered HTML/CSS; verify actual coverage |
   | Private/draft content, REST-hidden types, ACF/custom fields, exact menus | Authenticated helper/export when available and authorized |
   | REST blocked by security policy | Owner-approved helper/export; do not bypass access controls |
   | Authoritative old slugs or plugin redirects | Owner export/helper **if supported**; a public crawl only approximates them |

   Do not ask the owner to install the helper when public sources cover the scope.
   Inventory both Pages and posts (including sitemap-excluded public records),
   crawl internal links and inspect redirects, menus and CSS background images.
   Do not claim the helper exports a field without reading its current contract.
   The helper is distributed through Typeroll's documented package; do not claim
   WordPress.org availability. Listing it there is separate publication work.

b. Clean the HTML. Parse HTML and discard comments before extracting text or
   constructing blocks (comments may contain old phone-plugin metadata). Do not
   use regex tag removal as a text parser. Resolve relative `../` links against
   the source URL; preserve query strings and fragments. Report missing targets
   instead of pointing everything at the home page. Strip Elementor / Gutenberg / Breakdance class
   soup. Drop empty `<div>` and `<span>` wrappers. Keep semantic tags,
   tables, iframes from known hosts (YouTube / Vimeo / Calendly).
   Remove every `<script>`: plugin and theme JavaScript is never copied.
   Analytics and advertising tags move to the Integrations app behind the
   cookie banner (tr-migration-evidence, "Scripts, tracking and consent").

c. Migrate referenced images with `upload_media_from_url`. The customer's
   transfer Worker copies and verifies them directly in R2. Use the returned
   media reference only after verification. Stop and report a failed required
   transfer; do not silently hotlink the WordPress source.

The managed importer stores cleaned HTML. Typeroll does not convert HTML into blocks, and `set_page_mode` never rewrites HTML. You, the external agent, rebuild the imported content with ordinary block tools. The owner does not need to convert every Page manually. There is no editor conversion preview; it was removed in Core 0.2.58. Preserve the complete source before switching modes and never publish the empty intermediate Page.

d. Rebuild into editable blocks according to the selected intent. Preserve exact
   wording when text_intent is preserve; track approved changes when it is renew, independently of design. Map headings,
   prose, images, buttons and layout to standard fields first, then create
   reviewed custom types where needed. Use raw HTML only for a documented,
   exceptional fragment. Preserve anchors and map every old URL in either mode.

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
combined with another page, redirect to the relevant combined content. Do not
mark a public page excluded just because the new design omits it. Public URL
retirement requires a separately agreed exception; admin/session noise can be
excluded with a recorded reason.

Use a pattern only after verifying every affected source-to-destination mapping.
For an explicitly approved prefix change, `/old-blog/:slug` → `/articles/:slug`
can preserve intent if each destination contains the corresponding article.
Do not blanket-redirect category/tag/author/feed/year families to a home or blog
page. Date paths need actual route mappings; stripping a year is not enough.
Review source 404s rather than automatically excluding them.

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
  these require an explicit query-routing solution on the future host or a
  reviewed retirement decision. The old host cannot handle requests after its
  hostname moves.
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
- **Plugin JavaScript.** Never copy scripts from plugins, the theme or
  WordPress core into settings, pages, partials or block types, and never
  copy the cookie plugin. Carry analytics and advertising over by ID in the
  Integrations app with `cookie_consent.enabled: true`. The launch report
  fails on copied source scripts and on tracking outside consent.
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

### Raw-source media order (Core 0.2.35+)

Pass raw body HTML into conversion before any parse/serialize round trip with
another parser. Core applies browser tree construction before lazy-media cleanup.
An image-only H2 becomes an image at that position, not a semantic heading.
Compare ordered headings/text/media/CTAs, including malformed wrappers, lazy and
noscript images and related-content boundaries. Existing Pages are not rewritten;
repair confirmed placement errors against raw source without reimporting edits.


## Navigation and empty-media variants

Inventory first-step input banners independently of final submission providers.
Preserve their fields, required/minimum validation, service tabs and direct links,
mobile collapsed/open states and navigation even when the final integration is
deferred. Core 0.2.40 provides native `core/navigation_form` and mixed `core/tabs`.
Read their schema instead of rebuilding them in HTML or reintroducing a provider
block. Defaults are same-origin and tab-scoped; never place addresses in URLs or
claim cross-origin prefill. The receiving form must explicitly accept the fields.

Compare listing rows with both real and missing images. Use shared post-card
placeholder settings for theme decoration, preserving real featured images and
explicit `show_image: false`. Compare actual footer link height plus gap, wrapping,
focus and column breakpoints; compact navigation density is an intentional option.
Verify native preview and static output on the agreed viewport boundaries.


## Before retiring the source

Follow the starter's workflows/source-media.md. Archive unused and print originals
privately with a verified SHA-256 manifest and a restore test; do not import the
whole archive into CMS or assume ETag means MD5. ICC-convert CMYK/TIFF derivatives,
keep originals, and review colour/framing before uploading. Archive completion
and URL continuity are separate acceptance checks. Do not remove old hosting
until the owner has approved retirement.

Saving future hosts must not block normal publication on the current/temporary
address. Publish and review intended changes there first. Shortly before changing
DNS, explicitly prepare the last published snapshot for the future hosts with
`prepare_publishing_domain_change`. Review frozen indexing settings and approve
traffic separately. If newer content is published while the candidate waits,
prepare again before cutover; do not overwrite it with an outdated snapshot. Respect preserve/renew choices for owner-supplied facts;
"timeless" wording must not invent recurring events or erase preserved copy.
