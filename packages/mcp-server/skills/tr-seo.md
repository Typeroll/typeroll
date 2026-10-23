---
name: tr-seo
description: Use when the user asks to improve SEO, fix meta tags, add structured data, check page titles, or audit the site's search visibility. Triggers on "SEO", "meta descriptions", "Google ranking", "structured data", "JSON-LD", "sitemap", "sökoptimering", or "hjälp mig synas på Google".
---

# SEO audit and improvements for a Typeroll site

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks and partials) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


## What Typeroll handles automatically

- `<html lang>` from site `language` setting (per-page override via `language` field)
- `<title>` = `page.seo_title || page.title + settings.default_seo_suffix`
- `<meta name="description">` from `page.seo_description`
- `<meta name="robots">` from `page.noindex`
- `<meta property="og:*">` Open Graph tags from seo_title, seo_description, og_image
- `<link rel="canonical">` from `page.canonical_url` (falls back to the page's own URL)
- Article schema from `kind: "article"` + `author` + `date_published`
- Page schema from `kind: "page"` (default)
- `robots.txt` from `settings.robots_txt`
- Sanitized HTML that preserves semantic structure

## Recipe

### 1. Audit current state

```
list_pages status="all"
read_site_settings
```

For each page, check:
- Does the rendered title accurately identify the page, including any suffix?
- Is the description useful, specific and supported by the page's content?
  Search snippets may be rewritten or truncated; fixed character counts are
  not acceptance rules and must not cause padding or lost meaning.
- Is `og_image` set for the homepage and key landing pages?
- Does the page have exactly one `<h1>`?

### 2. Fix missing meta descriptions

```
batch_update_pages updates=[
  {page_id: "home",     patch: {seo_description: "Acme designar rum..."}},
  {page_id: "om-oss",   patch: {seo_description: "Vi är ett..."}},
  {page_id: "tjanster", patch: {seo_description: "Våra tjänster..."}}
]
```

Guidelines:
- Use the length needed for a clear, accurate summary; avoid padding
- Include the most important keyword naturally
- Make it a compelling reason to click, not a summary of the page's nav

### 3. Fix page titles

SEO title = what Google shows in search results.

If `settings.default_seo_suffix` is set (e.g. " — Acme Studio"), every
page whose `seo_title` is empty will show `title + suffix`. That's usually
fine for inner pages; set an explicit `seo_title` only when you want
something different.

```
update_site_settings {"default_seo_suffix": " — Acme Studio"}

# Set the canonical URL style once per site. Existing sites default to `always`.
update_site_settings {"trailing_slash": "always"}

# A page that must keep its exact campaign/title text can opt out.
update_page {"page_id": "campaign", "patch": {"append_seo_suffix": false}, "save": true}

update_page page_id="home" patch={
  "seo_title": "Acme Studio — Inredningsdesign i Stockholm"
}
```

### 3b. URL and article conventions

When creating or moving pages:

- Slugs are lowercase kebab-case: `our-services`, not `Our_Services`.
- Reflect hierarchy in the address. A team member lives at `/team/jane-doe`
  (set `path`, or use a content type whose `route_template` adds the
  prefix), not at `/jane-doe`. Breadcrumbs and their BreadcrumbList schema
  follow the resolved route.
- Blog posts and news get `kind: "article"` and an `author`: that emits
  Article JSON-LD and `og:type=article`. No author means no author in the
  rich result.
- Give shared pages, especially articles, their own `og_image`.

### 4. Add Open Graph images

Set `og_image` on pages that get shared on social media. If the site has
a branded hero image, upload it:

```
upload_media_from_url url="https://..." alt="Acme Studio — Inredningsdesign"
# → returns cdn_url

batch_update_pages updates=[
  {page_id: "home",     patch: {og_image: "<cdn_url>"}},
  {page_id: "om-oss",   patch: {og_image: "<cdn_url>"}}
]
```

OG image dimensions: 1200×630px ideal. The platform doesn't resize —
use a correctly-sized source image.

For pages without their own image, set a site-wide fallback and the X/Twitter
handle (admin permission, as in the portal Settings form):

```
update_site_settings default_og_image="<cdn_url>" twitter_handle="@acmestudio"
```

### 5. Add structured data (JSON-LD)

Typeroll auto-generates Article and Page schema, but you can override or
extend with custom JSON-LD per page. Example: LocalBusiness on the homepage.

The site-wide Organization schema comes from settings — set it once instead of
repeating it on every page (`null` clears it):

```
update_site_settings organization={"name":"Acme Studio","logo":"<cdn_url>","same_as":["https://www.linkedin.com/company/acme"]}
```

**FAQ, recipe and event pages have tools.** They validate the input, build
the schema.org JSON-LD and merge it into the page's `json_ld` (a node of the
same type is replaced, anything else is kept). Use them instead of
hand-writing JSON-LD, and copy the content from what the page visibly shows:

```
add_faq_schema page_id="faq" items=[
  {"question": "Do you deliver on weekends?", "answer": "Yes, Saturdays 9–15."}
]
add_recipe_schema page_id="kanelbullar" name="Kanelbullar"
  ingredients=["500 g vetemjöl", "2 tsk kanel"] instructions=["Blanda degen.", "Grädda i 225 °C."]
  prep_time="PT1H30M" cook_time="PT10M" recipe_yield="24 bullar" image_url="<cdn_url>"
add_event_schema page_id="sommarkonsert" name="Sommarkonsert"
  start_date="2026-06-12T19:00:00+02:00" location_name="Stadshuset"
  location_address="Storgatan 1, Sundsvall" offers_price=250 offers_currency="SEK"
```

Rules they enforce: FAQ needs at least one question with an answer; a recipe
needs a name, ingredients and steps, durations are ISO 8601 (`PT30M`) and
URLs absolute; an event needs a name and an ISO 8601 `start_date` (include
the UTC offset), `end_date` not before it, and a price needs
`offers_currency`. Read the returned `warnings`: a recipe without an image or
an event without a location is valid but not eligible for Google's rich
results. Like other content writes they land in the draft — `save: true` or
`commit_working_copy` when approved.

FAQ markup only belongs on a page that visibly presents those questions and
answers; Google penalizes FAQ markup for content the page does not show.

For other types write `json_ld` yourself:

```
update_page page_id="home" patch={
  "json_ld": "{\"@context\":\"https://schema.org\",\"@type\":\"LocalBusiness\",\"name\":\"Acme Studio\",\"url\":\"https://acme.se\",\"telephone\":\"+46812345\",\"address\":{\"@type\":\"PostalAddress\",\"streetAddress\":\"Drottninggatan 1\",\"addressLocality\":\"Stockholm\",\"postalCode\":\"111 51\",\"addressCountry\":\"SE\"}}"
}
```

**Important:** JSON-LD goes in the `json_ld` field as a JSON *string*
(not a nested object). The renderer injects it inside
`<script type="application/ld+json">`. To keep several nodes on one page,
store them as `{"@context":"https://schema.org","@graph":[…]}` — the
`add_*_schema` tools do this for you. Read the page first: an update
replaces the whole `json_ld` value.

Common schemas worth adding:
- Homepage: `LocalBusiness` or `Organization`
- About: `AboutPage`
- Contact: `ContactPage`
- Blog articles: auto-generated from `kind:"article"` + `author`
- FAQ, recipe and event pages: the `add_*_schema` tools above
- Products: `Product` with `offers`

**Instead of the `schema_markup` workflow.** That workflow runs the model with
the Organization's own AI key; on a Site without that access it fails with
`failure_code: "ai_not_enabled"`. Don't retry it. Do the same work here: read
each published page, pick the one type it genuinely represents (or none),
apply the tool or `json_ld` above, and tell the user you did it yourself.

### 6. robots.txt

The default robots.txt allows all crawlers. Update if needed:

```
update_site_settings {
  "robots_txt": "User-agent: *\nAllow: /\nSitemap: https://acme.se/sitemap.xml"
}
```

Typeroll doesn't generate a sitemap automatically in phase 1. If the
customer needs one, create a `/sitemap` page with HTML that lists all
published pages, or write a static `sitemap.xml` as a page with
`slug: "sitemap.xml"` and HTML-encoded XML (not recommended for large sites).

### 7. Canonical URLs

Set `canonical_url` when a page has a duplicate (e.g. the same content
accessible via two slugs after a migration):

```
update_page page_id="tjansterna" patch={
  "canonical_url": "https://acme.se/tjanster",
  "noindex": true
}
```

### 8. Language settings

```
update_site_settings {"language": "sv"}
```

Per-page override for multilingual content:
```
update_page page_id="about-en" patch={"language": "en"}
```

### 9. Heading audit

Use `search_pages` to find structural problems:

```
search_pages contains="<h1"      # pages that have at least one H1
```

Then `read_page` on pages that seem to have none or multiple. Fix via
`update_page patch={html_content: "<corrected HTML>"}`.

### 10. Deploy

```
trigger_deploy
get_deploy_status job_id=<id>
```

## Pitfalls

- **Don't stuff keywords.** Write descriptions for humans. Google ignores
  `<meta name="keywords">` (not a field in Typeroll anyway).
- **JSON-LD is a string, not a nested field.** Pass the entire schema as
  a JSON-encoded string in `json_ld`. The server escapes `</script` before
  injection.
- **OG images need absolute URLs.** The `cdn.typeroll.com` URLs are always
  absolute — use those.
- **`canonical_url` + `noindex` together.** If you noindex a page AND set
  canonical, the canonical is redundant (noindexed pages don't pass equity).
  Use one or the other.
- **Default suffix on homepage looks odd.** "Acme Studio — Acme Studio"
  happens when title="Acme Studio" and suffix=" — Acme Studio". Set an
  explicit `seo_title` for the homepage.
