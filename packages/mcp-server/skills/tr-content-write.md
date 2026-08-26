---
name: tr-content-write
description: Use when the user asks to write, draft, or rewrite a page on a Typeroll site. Loads the site's design conventions before writing so the new content matches the existing voice and style.
---

# Write a page that fits the site

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


The default failure mode for an AI writing a page is "good generic
HTML in the wrong voice." This skill makes the discovery step
non-optional.

## Recipe

### 1. Always discover first

```
get_site                          # site name (use it in copy)
read_site_settings                # tagline, contact info, brand colors
read_partial partial_id="header"  # what other pages exist in the nav
list_pages limit=5
batch_read_pages page_ids=[<2-3 representative pages>]
```

Read the actual HTML of an existing page. Note:
- Heading structure (single `<h1>` per page? subtitle pattern?)
- Whether the site uses CSS variables (`var(--color-primary)`) or
  hardcoded values
- Tone (sober, playful, technical, marketing-y)
- Length conventions (do existing pages run 200 words or 2000?)
- Whether internal links use absolute or relative URLs

### 2. Ask for the brief

If the user hasn't told you, ask:

- **Topic + purpose**: what's the page for, who's it for?
- **Key points**: must-include facts, calls to action
- **Target length**: short landing vs. long-form
- **Audience**: anything specific (existing customers, agencies,
  developers)
- **Reference page**: is there an existing page to match in tone or
  structure?

### 3. Draft

Write in semantic HTML, matching the site's conventions you observed
in step 1:

- Use `<section>`, `<article>`, `<h1>`/`<h2>`, `<p>`, `<ul>` — avoid
  div soup.
- Match the existing site's class naming or CSS variable usage. Don't
  introduce a new design system mid-page.
- Insert images via `<img src="https://cdn..." alt="...">` — use
  `list_media` to find existing images first; only generate new ones
  if necessary (see `tr-images` skill).
- Default status: `draft`. Don't auto-publish unless the user said so.

### 4. Create or update

```
# New page:
create_page title="..." slug="..." html_content="<full body>"
            status="draft" kind="page"
            seo_title="..." seo_description="..."

# Or update an existing one:
update_page page_id=<id> patch={ html_content: "..." }
```

For an existing page, `read_page` first and preserve the existing
structure — replace one section at a time rather than rewriting the
whole body, unless the user explicitly asked for a full redo.

### 5. Preview + iterate

```
get_preview_link page_id=<id>
```

Show the URL to the user. Iterate on feedback. Common rounds:
shortening, adding a CTA, tweaking SEO description.

### 6. Status change is the user's call

Don't `update_page status:"published"` without an explicit "looks
good, publish it" from the user. Same for `trigger_deploy`.

## SEO conventions worth knowing

- **`kind: "article"`** for blog posts and news. Switches to
  `og:type=article` + emits Article JSON-LD. Set `author` too — empty
  author = no Person schema = no author rich-result eligibility.
- **SEO title** target 50-60 chars. Past 60 Google truncates.
- **Meta description** target 150-160 chars. Don't write fluff to
  fill it; Google rewrites descriptions when they go off-topic.
- **OG image** per page matters for shareable content. For articles
  especially.

## Pitfalls

- Reading 0 pages and just inventing a design is the most common
  failure. Always sample at least one existing page first.
- Skipping the brief and producing 1000 words of plausible filler when
  the user wanted a 200-word landing. Ask up front.
- Auto-publishing. Don't.
