---
title: tr-seo — SEO Audit and Fix
description: Audit your site's search visibility and fix meta descriptions, Open Graph images, structured data, and more.
---

**Triggers on:** "SEO", "meta descriptions", "Google ranking", "structured data", "sitemap", "sökoptimering"

## What Typeroll handles automatically

You don't need to configure these — they work out of the box:

| Feature                     | How                                                                    |
| --------------------------- | ---------------------------------------------------------------------- |
| `<html lang>`               | From site `language` setting (per-page override available)             |
| `<title>`                   | `seo_title` if set, otherwise `title + default_seo_suffix`             |
| `<meta name="description">` | From `page.seo_description`                                            |
| `<meta name="robots">`      | From `page.noindex`                                                    |
| Open Graph tags             | From `seo_title`, `seo_description`, `og_image`                        |
| `<link rel="canonical">`    | From `page.canonical_url` (defaults to page URL)                       |
| Article JSON-LD             | Automatic for `kind: "article"` pages with `author` + `date_published` |

## What Claude audits and fixes

### Meta descriptions

- Checks every page for a `seo_description`
- Writes unique 150–160 char descriptions — compelling, keyword-natural, not keyword-stuffed
- Uses `batch_update_pages` for efficiency

### Page titles

- Sets `default_seo_suffix` (e.g. " — Acme Studio") via site settings
- Sets explicit `seo_title` on the homepage (to avoid "Acme Studio — Acme Studio")

### Open Graph images

- Uploads images via CDN and sets `og_image` on homepage and key landing pages
- OG images should be 1200×630px — Typeroll doesn't resize

### Structured data

- Adds `LocalBusiness` or `Organization` JSON-LD to the homepage
- Adds `ContactPage` to contact pages
- `json_ld` field takes the schema as a JSON string (not a nested object)

### Headings

- Checks every page for exactly one `<h1>`
- Fixes pages with zero or multiple H1s

## Example prompts

```
Audit and fix the SEO for all pages on this site.
```

```
Add LocalBusiness structured data to the homepage.
Address: Kungsgatan 5, Stockholm. Phone: 08-123 456.
```

```
Set a default title suffix and write meta descriptions for all pages.
```

## Common pitfalls

**"Acme Studio — Acme Studio"** — happens when `title` and `default_seo_suffix` are the same text. Fix: set an explicit `seo_title` for the homepage.

**JSON-LD is a string** — the `json_ld` field takes the entire schema as a JSON-encoded string, not a nested object. Claude handles this correctly when using the `update_page` tool.

**OG images need absolute URLs** — CDN URLs (`cdn.typeroll.com`) are always absolute. Don't use relative paths.

**`canonical_url` + `noindex` together** — noindexed pages don't pass equity, so a canonical on a noindexed page is redundant. Use one or the other.
