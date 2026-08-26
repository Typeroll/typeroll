---
name: tr-import-url
description: Use when the user wants to import or migrate content from a non-WordPress website — a Squarespace site, a Wix site, a static HTML site, a Webflow export, or any URL the user points at. Also triggers on "copy content from", "rebuild this site", "import from Squarespace/Wix/Webflow", or "make it look like this site". For WordPress sources use tr-migrate-wp instead.
---

# Import content from a non-WordPress site

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


## When to use this vs tr-migrate-wp

| Source | Use |
|---|---|
| WordPress with `/wp-json` accessible | `tr-migrate-wp` |
| WordPress with REST disabled | This skill (scrape HTML) |
| Squarespace, Wix, Webflow, static HTML | This skill |
| CSV / spreadsheet data | This skill (skip scraping, just parse) |
| Any URL the user points at | This skill |

## Preconditions

- Target Typeroll site exists with working header/footer.
- Source URL(s) accessible (check with a quick `fetch`; if blocked, mention
  it and ask the user for an HTML export or screenshot).

## Recipe

### 1. Inventory the source site

Fetch the homepage and build a URL list:

```
fetch <source-url>                    # root HTML
fetch <source-url>/sitemap.xml        # XML sitemap if it exists
```

Parse `<a href>` links to discover internal pages. Build a list:
- Homepage
- Top-level pages (About, Services, Contact, etc.)
- Any sub-pages that look important

Avoid: pagination URLs, session URLs, `/wp-admin`, `/cdn-cgi/`, query strings.

### 2. Learn the target's design

```
read_site_settings
read_partial partial_id="header"
list_pages limit=5
```

The goal is to understand what CSS variables, class names, and structural
conventions the target site uses so the imported content looks native.

### 3. Fetch and clean each source page

For each URL:

**a. Fetch the HTML.**
```
fetch <page-url>
```

If the site returns a bot-block (Cloudflare, 403, or clearly JS-only
SPA output), note it. Tell the user: "This page blocked direct fetching.
Can you provide the page source or an HTML export?"

**b. Extract the main content.**

Discard: nav, header, footer, cookie banners, chat widgets, scripts.
Keep: `<main>`, `<article>`, the largest content region.

Clean the HTML:
- Strip platform-specific classes: `sqsrte-*`, `wf-*`, `et_*`,
  `elementor-*`, `fl-*`, `divi-*`, `vc_*`
- Remove empty `<div>`, `<span>`, `<section>` wrappers (no class, no content)
- Unwrap redundant nesting: `<div><p>text</p></div>` → `<p>text</p>`
- Keep: `<h1>`–`<h6>`, `<p>`, `<ul>`, `<ol>`, `<img>`, `<a>`, `<table>`,
  `<blockquote>`, `<figure>`, `<figcaption>`, `<strong>`, `<em>`
- Fix headings: ensure exactly one `<h1>` per page (the page title)

**c. Transfer images.** For each `<img src>`:
```
upload_media_from_url url="<source-img-url>" alt="..."
```
Replace the src with the returned CDN URL. Skip tracking pixels
(1×1 images), decorative SVGs that are just icons, and anything
that 404s.

**d. Adapt to the target's design.**
Replace source-specific CSS classes with target conventions.
Use `var(--color-*)` for colors, `var(--font-*)` for type.

### 4. Create pages as drafts

```
create_page title="Om oss" slug="om-oss"
            html_content="<cleaned, adapted HTML>"
            content_mode="html" status="draft"
            seo_title="Om oss — Acme"
            seo_description="..."
```

Always draft first. The user signs off before publishing.

### 5. Handle redirects

If the source URLs differ from the target slugs, create redirects:

```
create_redirect from_path="/about" to_path="/om-oss"
create_redirect from_path="/services.html" to_path="/tjanster"
```

### 6. Preview with the user

```
get_preview_link
```

Walk through every imported page with the user. Common issues:
- Heading hierarchy wrong (two H1s, or H3 used where H2 belongs)
- Images missing alt text
- Squarespace column layouts that don't work without their grid system
- Embedded forms or maps that need re-setup

### 7. Publish + deploy

After approval:
```
batch_update_pages updates=[
  {page_id: "om-oss",  patch: {status: "published"}},
  {page_id: "tjanster", patch: {status: "published"}}
]
trigger_deploy
get_deploy_status job_id=<id>
```

## Platform-specific notes

### Squarespace
- Main content is inside `.content-wrapper` or `[data-section-theme]` blocks
- Portfolio images are usually high-resolution originals in `/universal/images/`
- JSON-LD is Squarespace's own schema — strip it
- Gallery blocks → convert to CSS grid with inline `<img>` tags

### Wix
- Wix sites are React SPAs — `fetch` returns an empty shell
- Ask the user for the Wix site's "Export to HTML" (available in some plans)
  or take screenshots for reference
- Best path: get content from the user (text + image files), rebuild clean

### Webflow
- Usually fetchable; clean output
- Classes like `w-container`, `w-row`, `w-col-*` can be stripped
- Webflow CMS items are server-rendered — they appear in the HTML

### Static HTML / old sites
- Often the cleanest import. Fetch, strip nav/footer, keep body.
- Watch for table-based layouts (pre-2010 sites) — convert to CSS grid

## Pitfalls

- **Don't import `<style>` blocks from the source site.** They reference
  external fonts, resets, and classes that don't exist in the target.
  Strip all `<style>` tags from source HTML and rewrite styles in the
  target's conventions.
- **Don't break the single-H1 rule.** Many source sites have no H1 or
  several. Fix it.
- **Squarespace/Wix forms.** They won't work after import — the backend
  is vendor-locked. Create a Typeroll form instead: `create_form`.
- **Analytics/tracking code.** If the source has GA4 or similar, don't
  copy it into pages. Set it via `update_site_settings scripts_head="..."`.
- **Videos.** YouTube/Vimeo embeds are fine (`<iframe>` is allowed).
  Hosted MP4s need re-uploading if the source URL won't persist.
