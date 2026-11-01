---
name: tr-seo
description: Use before a site's first launch and whenever the user asks to improve SEO, fix titles or meta descriptions, set a share image, add structured data, check the sitemap or robots.txt, control AI crawlers, or audit search visibility. Triggers on "launch", "go live", "SEO", "meta descriptions", "share image", "Google ranking", "structured data", "JSON-LD", "sitemap", "llms.txt", "AI crawlers", "sökoptimering", or "hjälp mig synas på Google".
---

# SEO and launch basics for a Typeroll site

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks and partials) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.

Run this recipe at launch, from the last step of `tr-new-site`, the migration
recipes and `tr-redesign-branch`, and whenever the user asks about search
visibility. Start with `read_site_readiness`: it lists what is missing on the
whole site, with a fix and a guide link per item. Most of what search engines
and AI agents need, the platform produces on its own; your work is the content
and the few settings only the owner can decide.

## What Typeroll handles automatically

Every publication produces these without any tool call. Do not recreate them
by hand, and do not add a second copy through `json_ld`, `scripts_head` or a
page.

**Head of every page**

- `<html lang>` from the Page `language`, otherwise the site `language`.
- `<title>`: `seo_title`, otherwise the Page title, plus
  `default_seo_suffix` unless the Page sets `append_seo_suffix: false`.
- `<meta name="description">`: `seo_description`, then
  `default_meta_description`, then the tagline.
- `<link rel="canonical">`: the resolved route on the publication's origin, or
  an explicit `canonical_url`.
- `<meta name="robots">` from `noindex` and `nofollow`, and from the site-wide
  and version restrictions.
- Open Graph and Twitter card tags (`og:title`, `og:description`, `og:image`,
  `twitter:card`, `twitter:site` from `twitter_handle`). Sharing text uses
  `og_title` and `og_description` when set.
- Share image chain: `og_image`, then a public Content type field mapped to
  `image`, then `default_og_image`, then the logo. An SVG, AVIF or TIFF share
  image from the site's media library is published as a 1200×630 PNG copy,
  contained on the theme's background colour; the original stays the page
  image. `og:image:type`, `og:image:width` and `og:image:height` are emitted.
- hreflang `<link rel="alternate">` for Pages with `alternates`.
- A Markdown rendition of each indexable Page at `<page path>index.md`,
  announced with `<link rel="alternate" type="text/markdown">`.
- The first content images are never lazy and get `fetchpriority="high"`, and
  a first section's background image is preloaded; later images are lazy.
  Logos and small icons do not count as the first images.

**Structured data (JSON-LD)**

- `Organization` and `WebSite` on the home page, from `site_name`, `tagline`,
  `organization`, `logo`, contact and social settings.
- `Article` for Pages with `kind: "article"`, with dates and `author`.
- `BreadcrumbList` on every page below the home page, from resolved routes.
- Content type schema from `schema_type` and `schema_field_map`.
- `FAQPage` from an Accordion block (`core/accordion`) when every item's title
  ends with a question mark (`?`, `？`, `؟`) and has an answer. Nothing is
  added when the Page's `json_ld` or its Content type schema already declares
  `FAQPage`, so it is never emitted twice.

**Site files**

- `robots.txt`: your `robots_txt` setting, with the sitemap lines added. The
  `ai_crawler_policy` setting adds the matching AI crawler groups.
  A duplicate load of a theme font in custom CSS or `scripts_head` is reported
  by the readiness item `duplicate_fonts`, not removed.
- `sitemap.xml`: published, indexable Page routes. With more than 45,000
  URLs it becomes a sitemap index over numbered `sitemap-<n>.xml` files.
  Pages with `alternates` carry their hreflang entries.
- `sitemap-images.xml`: the public images of each indexable Page.
- `llms.txt`: a Markdown map of the site for AI agents, grouped by Content type
  and language section, with each Page's description and links to the
  sitemap and `llms-full.txt`.
- `llms-full.txt`: the Markdown of the indexable Pages in one file, with a size
  cap.
- The `Content-Signal` response header, when `ai_crawler_policy` is not
  `allow_all`.

Noindex and unlisted Pages, drafts and blocked versions are left out of every
site file.

## Recipe

### 1. Read the site's state

```
read_site_readiness
read_site_settings
list_pages status="all"
```

`read_site_readiness` returns `items` with `id`, `status` (`ok`,
`suggestion` or `warning`), `message`, `fix` and `guide`. Work through the
warnings first. It never blocks a publication, and a clean report is not
approval to publish.

For each important Page, check:

- Does the title identify the page, including any suffix?
- Is the description specific and supported by the page's content? Search
  engines may rewrite or shorten snippets; never pad text to a length.
- Does the page have exactly one H1?

### 2. Launch basics only the owner can decide

Read `read_site_settings` first and ask only for what is missing. Each item is
optional; record a skipped item in `decisions.md`.

- **Default share image.** Ask the user to choose or create the image shown
  when a page has none of its own: upload one (`create_upload_url` or
  `upload_media_from_url`), pick one with `list_media`, or create one with
  `tr-imagegen`. Use 1200×630 px PNG or JPEG. Never generate a title card
  from the page title instead.

  ```
  update_site_settings default_og_image="<cdn_url>" twitter_handle="@acmestudio"
  ```

- **Organization and profiles.** The business name, logo and official profile
  URLs:

  ```
  update_site_settings organization={"name":"Acme Studio","logo":"<cdn_url>","same_as":["https://www.linkedin.com/company/acme"]}
  ```

- **Site description and icons.** `default_meta_description` for pages without
  their own description, and `favicon`, `apple_touch_icon` and `icon_192`
  (see `tr-brand`).
- **AI crawlers.** `ai_crawler_policy` is `allow_all` (the default, which writes
  nothing), `no_training` or `block_all`:

  ```
  update_site_settings ai_crawler_policy="no_training"
  ```

  `no_training` disallows training-only crawlers such as GPTBot, ClaudeBot,
  Google-Extended, Applebot-Extended and CCBot, and states
  `Content-Signal: search=yes, ai-input=yes, ai-train=no`. It never blocks
  Googlebot, Bingbot or Applebot. On Cloudflare, the zone's own AI bot policy
  is enforced at the edge and wins over `robots.txt`; blocking Training there
  can also block Googlebot, Bingbot and Applebot. The readiness item
  `ai_crawler_zone_conflict` reports a mismatch. Never change the zone's
  settings yourself: tell the owner what to change.
- **Pages a business needs.** Privacy policy, contact and a 404 page. Set the
  privacy page as `cookie_consent.privacy_policy_url` when the cookie banner is
  on.

### 3. Titles and descriptions

```
update_site_settings {"default_seo_suffix": " — Acme Studio", "trailing_slash": "always"}

batch_update_pages updates=[
  {page_id: "home",     patch: {seo_title: "Acme Studio — Interior design in Stockholm", seo_description: "Acme designs..."}},
  {page_id: "about",    patch: {seo_description: "We are..."}}
]
```

- Give the home page an explicit `seo_title`, so the suffix does not repeat
  the site name.
- A page that must keep its exact title can set `append_seo_suffix: false`.
- The readiness report flags duplicate titles and descriptions, missing or
  repeated H1s and descriptions over 160 characters. Fix them in the content;
  they are warnings, not rules to pad or trim text mechanically.

### 4. URLs and articles

- Slugs are lowercase kebab-case: `our-services`, not `Our_Services`.
- Reflect hierarchy in the address: a team member lives at `/team/jane-doe`
  (set `path`, or use a Content type whose route pattern adds the prefix).
  Breadcrumbs and their schema follow the resolved route.
- Blog posts and news get `kind: "article"` and an `author`.
- Give shared pages, especially articles, their own `og_image`.
- Link every published page from somewhere. The readiness item `orphan_pages`
  lists pages that no internal link reaches; `check_internal_links` finds
  broken saved links.

### 5. Structured data beyond the automatic output

Use structured data only for information the page visibly shows.

- **FAQ:** an Accordion block whose item titles are questions ending in a
  question mark, each with an answer, produces `FAQPage` automatically. For
  FAQ content in another block, use `add_faq_schema`.
- **Recipes and events:** `add_recipe_schema` and `add_event_schema` validate
  the input, build the JSON-LD and merge it into the Page's `json_ld`:

  ```
  add_recipe_schema page_id="kanelbullar" name="Kanelbullar"
    ingredients=["500 g flour", "2 tsp cinnamon"] instructions=["Mix the dough.", "Bake at 225 °C."]
    prep_time="PT1H30M" cook_time="PT10M" recipe_yield="24 buns" image_url="<cdn_url>"
  add_event_schema page_id="summer-concert" name="Summer concert"
    start_date="2026-06-12T19:00:00+02:00" location_name="City Hall"
    location_address="Main Street 1, Sundsvall" offers_price=250 offers_currency="SEK"
  ```

  Read the returned `warnings`: a recipe without an image or an event without
  a location is valid but not eligible for rich results.
- **Products, software and directories:** set the Content type's `schema_type`
  (for example `Product` or `SoftwareApplication`) and map its fields with
  `schema_field_map` in `update_content_type`, rather than writing JSON-LD on
  each Page.
- **Other types:** write `json_ld` yourself as a JSON string. Keep several
  nodes in one `{"@context":"https://schema.org","@graph":[…]}`. An update
  replaces the whole value, so read the Page first.

  ```
  update_page page_id="home" patch={
    "json_ld": "{\"@context\":\"https://schema.org\",\"@type\":\"LocalBusiness\",\"name\":\"Acme Studio\",\"url\":\"https://acme.se\"}"
  }
  ```

The readiness item `structured_data` reports JSON-LD that is missing required
properties or has invalid dates or URLs.

**Instead of the `schema_markup` workflow.** That workflow uses the
Organization's own AI key; without it, it fails with
`failure_code: "ai_not_enabled"`. Don't retry it. Read each published page,
choose the one type it represents (or none), apply the tools above, and tell
the user you did it yourself.

### 6. robots.txt, indexing and canonicals

- `robots_txt` holds custom crawl rules; the sitemap lines are added for you.
  Use `ai_crawler_policy` for AI crawlers instead of hand-written groups.
- To keep a page out of search but crawlable, set `noindex: true`. Blocking a
  path in `robots.txt` stops crawlers from reading that directive.
- Set `canonical_url` only when a page deliberately points elsewhere, for
  example a cross-domain duplicate. Don't combine it with `noindex`.
- `check_site_indexing` reports the robots policy of the actual address,
  including response headers.

### 7. Languages

```
update_site_settings {"language": "sv"}
update_page page_id="about-en" patch={"language": "en"}
```

For several languages on one site, use `language_sections` and Page
`alternates`; see the multilingual sites guide.

### 8. Search Console

Ask the owner to add the site in Google Search Console. A Domain property
verified with a DNS TXT record covers every address. For a URL-prefix
property, put Google's verification `<meta>` tag in `scripts_head` (admin
permission). Then submit `https://<host>/sitemap.xml`. Record the property in
`brief/seo.md`. After launch, `import_gsc_performance` reads page clicks and
impressions into the URL inventory.

### 9. Publish and check

With the user's approval:

```
read_site_readiness
trigger_deploy
get_deploy_status job_id=<id>
read_site_readiness
```

Run the report again after the publication. It reads saved content and
settings: the AI crawler zone check needs the site's website host, and a Search
Console property verified by DNS is not visible to Typeroll, so confirm it in
Search Console. Fix or record every open item, and save the result under the
starter's `qa/` folder. In the portal, the site's overview page has the same
report under **Launch readiness → Check readiness**. It runs on request, not
after every publication.

## Pitfalls

- **Don't stuff keywords.** Write descriptions for people. Google ignores
  `<meta name="keywords">`, and Typeroll has no such field.
- **JSON-LD is a string.** Pass the whole schema as a JSON-encoded string in
  `json_ld`. The server escapes `</script` before output.
- **Share images need absolute URLs.** Media library `cdn_url` values are
  absolute.
- **FAQ markup must match visible content.** Search engines penalize FAQ
  markup for questions the page does not show.
- **A site file you write by hand loses.** Don't create Pages named
  `sitemap.xml`, `robots.txt` or `llms.txt`; the publication writes them.
