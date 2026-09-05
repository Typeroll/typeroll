---
name: tr-migrate-wp
description: Use when the user asks to migrate a WordPress site to Typeroll, mentions wp-json, or names a WP source URL. Walks the WP REST API, rebuilds pages in the target site's design, transfers media, sets redirects, leaves everything as drafts for human review.
---

# Migrate from WordPress to Typeroll

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


The platform's in-portal migration workflow is the "managed" path for
customers who want one-click. This skill is the "power-user" path: you
do it locally, mix data sources freely, and the user (consultant /
agency) reviews each step in their terminal.

## Preconditions

**Run the readiness check FIRST — before touching any content:**

```
get_migration_readiness source_url="https://oldsite.com"
```

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
pre-cutover parity check can't run), no AI reconstruction key, forms without a
notification address, or a target site with no design to rebuild INTO.

Then the ordinary preconditions:

- `@typeroll/mcp-server` configured with a valid `TYPEROLL_API_KEY`.
- The source WP site has `/wp-json` reachable (Google for "wordpress
  REST API disabled" if not — common for hardened hosts).
- The Typeroll target site exists **and already carries the design** —
  settings, header/footer, one or two example pages. The migration rebuilds
  old content in the NEW design; with nothing to imitate it inherits the old
  site's look.
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

### 3. Migrate one page at a time, draft status

For each source URL:

a. Fetch from WP. Prefer the helper plugin's authenticated endpoint
   (`/wp-json/typeroll/v1/...`) if available — it bypasses
   `show_in_rest=false` and returns ACF + builder fields. Otherwise
   fall back to `/wp-json/wp/v2/<post-type>?slug=<slug>`.

b. Clean the HTML. Strip Elementor / Gutenberg / Breakdance class
   soup. Drop empty `<div>` and `<span>` wrappers. Keep semantic tags,
   tables, iframes from known hosts (YouTube / Vimeo / Calendly).

c. Migrate referenced images:
   - For each `<img src>` and CSS `background-image: url()`:
     1. Download the source image locally.
     2. `create_upload_url filename=... content_type=...` → returns
        `{ upload_url, cdn_url, media_id }`.
     3. PUT the bytes to `upload_url` (curl or fetch with the same
        content type).
     4. Replace the `src` with `cdn_url` in the rewritten HTML.
   - Use `update_media media_id=... alt_text="..."` to set a real alt
     text (existing WP `alt` attribute or `aria-label`; fall back to
     filename only as a last resort).

d. Reconstruct in the target's design. The cleaned HTML is rarely
   ready to ship — typical fixes: replace WP `wp-block-*` classes
   with the target's CSS variables; turn Elementor sections into
   plain `<section>` with the target's spacing; fix headings so the
   page has exactly one `<h1>`. If you're confident, batch these
   through `bulk_replace_text` with `dry_run: true` first.

e. Write the page as a draft:

   ```
   create_page title="..." slug="<preserved-from-wp>"
               html_content="<reconstructed>"
               status="draft" kind="article" author="..."
               seo_title="..." seo_description="..."
   ```

   **Preserve the source URL.** WP post URLs like
   `/2024/01/foo-bar/` go in as `slug: "2024/01/foo-bar"`. The
   slug supports slashes; encode the WP permalink structure verbatim
   when the customer wants existing links to keep working.

### 4. Redirects

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
| Category archives | `from_path="/category/*"` → `to_path="/blogg/:splat"` (or a single landing page) |
| Tag archives | `from_path="/tag/*"` → `to_path="/blogg"` |
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
```

The inventory merges slash-equivalent URLs into one work item but preserves
their source spellings in `observed_paths`. Verification requests every one of
those spellings; treat a failing variant as a real gap even when coverage is
otherwise complete. Fresh builds expand redirect sources to both slash forms.

### 5. Preview + review with the user

```
get_preview_link page_id=<id>                    # one URL the user can click
```

Open in the user's browser. The preview navigates the whole site from
one mint. Iterate on feedback: pages, header, footer.

### 6. Ship

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
