---
name: tr-directory
description: Use when the user wants to build a directory site or import a structured dataset (restaurants, products, events, agencies, etc.) where each item should have its own URL. Covers collection schema creation, per-item URLs via route_template, listing page, deploy.
---

# Build a directory site from external data

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


Typeroll collections support per-item URLs: every published item
in a collection with a `route_template` materialises as its own static
page at build time. This is the right pattern when you have hundreds
of similar entities (restaurants, products, listings, profiles).

## Big-picture flow

1. **Data source** → 2. **Collection schema** → 3. **Items** → 4. **Listing page**
→ 5. **Preview** → 6. **Deploy**

You drive everything from Claude Code locally — the scrape, the data
shaping, the writes. The MCP just receives the final shape.

## Recipe

### 1. Get the data

Whatever source the user has — scraped CSV, public API, vendor feed,
manual research, another LLM's output. Normalise to a flat shape:
one object per item with stable, kebab-case field names.

```jsonc
[
  {
    "title": "Joe's Pizza",
    "slug": "joes-pizza",
    "address": "123 Main St, Anytown",
    "phone": "+1-555-0100",
    "cuisine": "italian",
    "rating": 4.5,
    "image": "https://...",        // optional: a hosted image URL
    "excerpt": "Family-run since 1987...",
    "body": "<p>Long-form description with HTML.</p>"
  }
]
```

The `slug` field is what populates `route_template`. Make it
kebab-case, unique within the dataset. If the source doesn't have one,
derive from `title`: lowercase, replace non-alphanumeric with `-`,
collapse consecutive dashes.

### 2. Decide the URL structure with the user

Common patterns:

- `/restaurants/{slug}` (default — simple, predictable)
- `/r/{slug}` (compact)
- `/{cuisine}/{slug}` (categorised)
- `/dir/{slug}` (short prefix to avoid collisions with page slugs)

Pick one before creating the collection — changing `route_template`
later renames every URL and requires redirect rules.

### 3. Create the collection schema

```
create_collection
  name="restaurants"
  label_singular="Restaurant"
  label_plural="Restaurants"
  icon="🍕"
  fields=[
    {"name":"title","label":"Name","type":"text","required":true},
    {"name":"slug","label":"Slug","type":"text","required":true},
    {"name":"address","label":"Address","type":"text"},
    {"name":"phone","label":"Phone","type":"text"},
    {"name":"cuisine","label":"Cuisine","type":"text"},
    {"name":"rating","label":"Rating","type":"number"},
    {"name":"image","label":"Image URL","type":"text"},
    {"name":"excerpt","label":"Excerpt","type":"textarea"},
    {"name":"body","label":"Body","type":"richtext"}
  ]
  slug_field="slug"
  sort_field="title"
  sort_dir="asc"
  route_template="/restaurants/{slug}"
  item_template_html="<article class=\"directory-item\">
    <header>
      <h1>{{title}}</h1>
      {{cuisine}} · ⭐ {{rating}}
    </header>
    <img src=\"{{image}}\" alt=\"{{title}}\" />
    <address>{{address}} · <a href=\"tel:{{phone}}\">{{phone}}</a></address>
    <section class=\"description\">{{{body}}}</section>
  </article>"
```

The `item_template_html` is what renders for each item. `{{field}}`
HTML-escapes; `{{{field}}}` leaves raw (use for richtext bodies that
intentionally carry HTML).

### 4. Bulk-import items

Loop over your data array. For each item:

```
create_collection_item
  collection="restaurants"
  fields={ title:"Joe's Pizza", slug:"joes-pizza", ... }
  status="published"
```

For larger datasets (1000+), batch outside the MCP — spawn 5 parallel
`create_collection_item` calls at a time, watch the 60-writes/min rate
limit (you'll hit it on big imports, the API returns 429 with
`Retry-After`).

Set `status: "draft"` for items the user still needs to review; only
published items get static pages.

### 5. Build a listing page

Items have per-item URLs but not a default index. Create one with a
marker pair that `regenerate_collection_listing` will keep up to date:

```
create_page
  title="Restaurants"
  slug="restaurants"
  status="published"
  html_content="<h1>All restaurants</h1>
    <!-- typeroll:listing:restaurants -->
    <!-- /typeroll:listing:restaurants -->
  "
```

Then populate (and refresh whenever items change) with one call:

```
regenerate_collection_listing
  collection="restaurants"
  page_id="restaurants"
  item_template="<article class=\"directory-card\">
    <h2><a href=\"{{url}}\">{{title}}</a></h2>
    <p>{{cuisine}} · ⭐ {{rating}}</p>
    <p>{{address}}</p>
  </article>"
  wrap_open="<div class=\"directory-grid\">"
  wrap_close="</div>"
```

`{{field}}` substitutes HTML-escaped, `{{{field}}}` raw (for richtext
fields), `{{url}}` resolves through the collection's `route_template`.
The tool replaces only what's between the marker pair — anything before
or after the markers stays put.

When the customer adds a new restaurant later, the agent re-runs the
same `regenerate_collection_listing` call and the index updates. No
diff-the-HTML-by-hand, no stale listings.

(When the block editor lands, you'll be able to drop in a "collection
listing" block instead of hand-writing this. For now, raw HTML.)

### 6. Preview an item

```
get_preview_link collection_name="restaurants" item_id="<id>"
```

Returns a URL the user can open. Internal links inside the preview
stay inside the preview surface, so navigating to another item works.

### 7. Deploy

```
trigger_deploy
get_deploy_status job_id=<id>
```

Each published item gets its own URL in the static build, with
`sitemap.xml` automatically including them all.

## Patterns worth knowing

### Conditional rendering without Mustache conditionals

`item_template_html` substitution is plain `{{field}}` / `{{{field}}}` — no loops, no `{{#if}}` blocks. To hide a section/element when a field is empty, use a data-attribute that resolves to either the empty string or a non-empty value, plus a CSS selector:

```html
<aside class="podcast-guest" data-empty-if-blank="{{guest_name}}">
  <h2>Om gästen</h2>
  <p>{{guest_bio}}</p>
</aside>
```
```css
.podcast-detail [data-empty-if-blank=""] { display: none !important; }
```

When `guest_name` is empty, the attribute becomes `data-empty-if-blank=""` and the CSS matches and hides the block. When non-empty, the rule misses and the block renders. Works for optional images, optional audio, optional sub-sections — any "show only if this field has a value" need.

### Pre-render list-typed source data into a richtext field

For nested arrays in the source (e.g. `chapters: [{time, title}, …]`), pre-render to HTML during import and store in a dedicated `*_html` richtext field. The template just splats `{{{chapters_html}}}`. Three concrete recipes worth applying:

1. **Podcast detail page:** `chapters_html`, `guest_links_html`.
2. **Restaurant directory:** `hours_html` table.
3. **Product directory:** `variants_html` grid.

See `tr-collection-template` for full code examples.

### Batch-import via subagent for large datasets

22+ `create_collection_item` calls bloat the main agent's context with response payloads. Spawn a `general-purpose` subagent with the manifest path and a tight contract ("report ok/fail per item, end with a one-line summary"). The sub returns one line per item instead of a JSON blob per item back into the main turn.

## Pitfalls

- **Slugs must be unique within the collection** — duplicates cause
  build failures (two pages claiming the same URL). De-dupe before
  importing.
- **Don't reuse `slug` across collections without thinking.**
  `/restaurants/joes` and `/products/joes` are fine; just avoid
  `/joes` for both (collection items vs. pages don't collide because
  pages always win, but two collections sharing a `slug_field=slug`
  with the same `route_template` is a foot-gun).
- **Required fields.** `route_template="/restaurants/{slug}"` will
  silently skip items where `slug` is missing. Check
  `list_collection_items` after import — if you imported 500 and the
  listing only shows 480, look at the dropped 20's source data.
- **Template too clever.** Substitution is plain `{{field}}` — no
  loops, no conditionals. If your design needs more, prefer flat
  fields (`star_html`, `rating_label`) prebuilt in the data step.
  See the "Patterns worth knowing" section above.
- **Field type changes drift data.** Adding a new field after import
  is fine; renaming one orphans the old data on every item. Plan the
  schema before import.
- **Never derive display labels from slugs.** Slugs are ASCII-folded
  for URL-safety. Computing the visible label as
  `slug.replace("-", " ").capitalize()` produces **wrong words** in
  languages with diacritics: `innehall` → `Innehall` (should be
  `Innehåll`), `affarssystem` → `Affärssystem`. Always carry the
  real title from the source and look it up by slug:

  ```python
  slug_to_title = {t["slug"]: t["title"] for t in topic_manifest}
  label = slug_to_title.get(slug, slug.replace("-", " ").title())  # fallback only
  ```

  Caught during a real migration where 20 of 22 podcast detail pages
  ended up with `Innehall` / `Prissattning` / `Affarssystem` in their
  topic chips.
- **Numeric `sort_field` sorts numerically** as of the 2026-05 fix —
  episode 9 ranks below episode 23 under desc sort. Earlier versions
  compared as strings (9 > 23), so if you're working against an older
  portal deploy add a `sort_key` text field with zero-padded values
  (`f"{episode:03d}"`) and set `sort_field: "sort_key"` instead.

## Mixing scraped + generated content

The whole point of the local-agent model: you can blend sources.

- Scrape addresses + phone from a yellow-pages site.
- Generate excerpt + body from a local Claude pass over the raw
  scraped HTML.
- Generate hero images per item via `tr-images`.
- All three merged into one `create_collection_item` per record.

Keep a local manifest (`./directory-state.json`) of what's been
imported so a partial run is resumable. The MCP doesn't track that
state — your local script does.
