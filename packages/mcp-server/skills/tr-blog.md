---
name: tr-blog
description: Use when the user wants to set up a blog, news section, podcast feed, or any time-ordered article-style content on a Typeroll site. Triggers on "add a blog", "set up news", "article section", "create posts", "podcast", "inlägg", "nyheter", "avsnitt", or any feed-of-dated-entries pattern.
---

# Set up a blog / news section

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


A blog in Typeroll is a **collection with `item_template_html` + `route_template`**. Every published item materialises as its own static page at build time — there is **no need to call `create_page` per article**. The detail design lives once in `item_template_html`; the listing lives once in a page with a `<!-- typeroll:listing -->` marker that `regenerate_collection_listing` refreshes.

If you find yourself about to create 20 pages for 20 articles, stop — you're using the old pattern. The recipe below is the right one.

## Preconditions

- Site exists with working header/footer.
- Collection name picked (`blog`, `news`, `artiklar`, `podcast`, `avsnitt`).
- URL structure picked: `/blog/{slug}`, `/news/{slug}`, `/podd/{slug}`. Changing later renames every URL.

## Recipe

### 1. Create the collection with detail template baked in

```
create_collection {
  "name": "blog",
  "label_singular": "Artikel",
  "label_plural": "Artiklar",
  "icon": "📝",
  "slug_field": "slug",
  "sort_field": "date",
  "sort_dir": "desc",
  "route_template": "/blog/{slug}",
  "item_template_html": "<article class=\"post\">\n  <header class=\"post__header\">\n    <time>{{date}}</time>\n    <h1>{{title}}</h1>\n    {{#author}}<p class=\"byline\">av {{author}}</p>{{/author}}\n  </header>\n  {{#image}}<img class=\"post__hero\" src=\"{{image}}\" alt=\"{{title}}\" />{{/image}}\n  <div class=\"post__body\">{{{body}}}</div>\n</article>\n<style>\n.post{max-width:42rem;margin:3rem auto;padding:0 1rem}\n.post__header time{color:var(--color-text-light);font-size:0.85rem}\n.post__header h1{font-family:var(--font-heading);font-size:2.25rem;margin:0.25rem 0}\n.byline{color:var(--color-text-light);font-size:0.9rem}\n.post__hero{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:0.5rem;margin:2rem 0}\n.post__body{font-size:1.05rem;line-height:1.7}\n.post__body h2{font-family:var(--font-heading);margin-top:2rem}\n.post__body p{margin-bottom:1.25rem}\n</style>",
  "fields": [
    {"name": "title",   "type": "text",     "label": "Rubrik",    "required": true},
    {"name": "slug",    "type": "text",     "label": "URL-slug",  "required": true},
    {"name": "date",    "type": "date",     "label": "Datum",     "required": true},
    {"name": "author",  "type": "text",     "label": "Författare"},
    {"name": "excerpt", "type": "textarea", "label": "Ingress"},
    {"name": "body",    "type": "richtext", "label": "Brödtext"},
    {"name": "image",   "type": "image",    "label": "Omslagsbild"}
  ]
}
```

**About `item_template_html`:**
- `{{field}}` HTML-escapes the value (use for plain text).
- `{{{field}}}` leaves it raw (use for `body` and any richtext).
- `{{#field}}...{{/field}}` is a conditional — render the block only if the field is truthy. Useful for optional images, authors, etc.
- **No loops, no nested conditionals.** If you need either, pre-render the HTML in a field on the item itself (see tr-collection-template for patterns).

**Field name rule:** ASCII only, lowercase, `[a-z][a-z0-9_-]*`. `ä→a`, `ö→o`, `å→a` for the `name`; the `label` can be anything.

### 2. Seed with real content

```
create_collection_item collection="blog" status="published" fields={
  "title":   "Vår designfilosofi",
  "slug":    "var-designfilosofi",
  "date":    "2025-05-15",
  "author":  "Anna Lindström",
  "excerpt": "Vi tror på enkelhet med syfte — varje beslut ska kunna motiveras.",
  "body":    "<p>Lång brödtext här...</p><h2>En underrubrik</h2><p>Mer text...</p>",
  "image":   "https://cdn.typeroll.com/..."
}
```

If `image` is a URL from elsewhere, upload it first via `upload_media_from_url` and use the returned CDN URL.

Each published item with this collection's `route_template` automatically becomes `/blog/{slug}` at deploy time — you do **not** need to call `create_page`.

### 3. Build the listing page (once)

Create a single page that hosts the listing. The HTML between the `typeroll:listing` markers gets regenerated whenever the collection changes:

```
create_page title="Artiklar" slug="blog" status="published" content_mode="html"
  html_content="<section class=\"blog-listing\">
  <div class=\"container\">
    <h1 class=\"section-title\">Artiklar</h1>
    <!-- typeroll:listing:blog -->
    <!-- /typeroll:listing:blog -->
  </div>
</section>
<style>
.blog-listing{padding:4rem 0}
.blog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:2rem;margin-top:2rem}
.blog-card{border:1px solid var(--color-surface);border-radius:0.5rem;overflow:hidden}
.blog-card a{text-decoration:none;display:block;color:var(--color-text)}
.blog-card img{width:100%;aspect-ratio:16/9;object-fit:cover}
.blog-card__body{padding:1.5rem}
.blog-card__date{font-size:0.8rem;color:var(--color-text-light);display:block;margin-bottom:0.5rem}
.blog-card__title{font-family:var(--font-heading);font-size:1.25rem;margin-bottom:0.5rem}
.blog-card__excerpt{color:var(--color-text-light);font-size:0.9rem;margin-bottom:1rem}
.blog-card__cta{color:var(--color-accent);font-size:0.85rem;font-weight:600}
</style>"
```

### 4. Populate the listing (and re-run after every change)

```
regenerate_collection_listing
  collection="blog"
  page_id="blog"
  item_template="<article class=\"blog-card\">
    <a href=\"{{url}}\">
      {{#image}}<img src=\"{{image}}\" alt=\"{{title}}\">{{/image}}
      <div class=\"blog-card__body\">
        <time class=\"blog-card__date\">{{date}}</time>
        <h2 class=\"blog-card__title\">{{title}}</h2>
        <p class=\"blog-card__excerpt\">{{excerpt}}</p>
        <span class=\"blog-card__cta\">Läs mer →</span>
      </div>
    </a>
  </article>"
  wrap_open="<div class=\"blog-grid\">"
  wrap_close="</div>"
```

`{{url}}` resolves through the collection's `route_template`. Only the content between the markers is replaced; everything else on the page stays put. Re-run this whenever items are added, edited, or unpublished.

### 5. Update the header partial to link to the listing

```
read_partial partial_id="header"
replace_partial partial_id="header" html_content="<updated with /blog link>"
```

### 6. Preview a single article

```
get_preview_link collection_name="blog" item_id="<id>"
```

The returned URL renders the item through `item_template_html` exactly as it'll appear in production.

### 7. Deploy

```
trigger_deploy
get_deploy_status job_id=<id>
```

The build produces one HTML file per published article at `/blog/<slug>` plus the listing at `/blog`, and includes them all in `sitemap.xml`.

## Adding a new article later

```
create_collection_item collection="blog" status="published" fields={ ... }
regenerate_collection_listing collection="blog" page_id="blog" item_template="..." wrap_open="..." wrap_close="..."
trigger_deploy
```

Three calls. No per-article `create_page`. No HTML diffing by hand.

## Pitfalls

- **Don't fall back to "one page per article".** That was the pre-`item_template_html` pattern. It's strictly worse now: design changes mean editing N pages, you lose `{{url}}` resolution in listings, sitemap doesn't include items, previews can't surface a per-item URL — and the API will reject your attempt anyway. `create_page` rejects slugs containing slashes ("Invalid slug … slugs must not contain slashes"), so `slug: "blog/foo"` doesn't even get through. The collection's `route_template` is the only path to nested URLs.
- **Slugs must be unique within the collection.** `regenerate_collection_listing` will silently drop items where `slug` is missing; the listing count will be lower than the item count.
- **Don't use non-ASCII field names.** `datum` not `Datum`; `forfattare` not `författare` in the `name`. The `label` is free-form.
- **Listing goes stale if you forget step 4.** Every item change needs `regenerate_collection_listing`. Add it to your mental checklist after every `create/update_collection_item`.
- **`{{#field}}...{{/field}}` only checks truthiness.** Empty string and the field being absent both count as falsy. If you need "render this block when `published_at` is later than today", do it in the data step — set a flag field.
- **Template too clever.** Mustache substitution has no loops or arithmetic. For an article with chapter timestamps, multiple authors, a guest with nested links — pre-render the HTML into a single field at `create_collection_item` time. See `tr-collection-template` for concrete patterns.

## When you want a page that ISN'T a collection item

A normal `create_page` is still right for:
- The blog's about/contact pages.
- Editorial standalone features.
- Anything that doesn't fit the "list of dated entries" mould.

Just don't use `create_page` *for the entries themselves*.
