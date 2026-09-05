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


A blog in Typeroll is a **collection with `item_template_blocks` +
`route_template`**. Every published item materialises as its own static page at
build time — there is **no need to call `create_page` per article**. Start with
the native `article` preset; the listing is a block-mode page with
`core/collection_list` and updates at build time.

If you find yourself about to create 20 pages for 20 articles, stop — you're using the old pattern. The recipe below is the right one.

## Preconditions

- Site exists with working header/footer.
- Collection name picked (`blog`, `news`, `artiklar`, `podcast`, `avsnitt`).
- URL structure picked: `/blog/{slug}`, `/news/{slug}`, `/podd/{slug}`. Changing later renames every URL.

## Recipe

### 1. Create the collection with a native item composition

```
create_collection {
  "name": "blog",
  "label_singular": "Artikel",
  "label_plural": "Artiklar",
  "icon": "📝",
  "slug_field": "slug",
  "sort_field": "published_at",
  "sort_dir": "desc",
  "route_template": "/blog/{slug}",
  "template_kind": "article",
  "fields": [
    {"name": "title",   "type": "text",     "label": "Rubrik",    "required": true},
    {"name": "slug",    "type": "text",     "label": "URL-slug",  "required": true},
    {"name": "published_at", "type": "date", "label": "Datum", "required": true},
    {"name": "author",  "type": "text",     "label": "Författare"},
    {"name": "excerpt", "type": "textarea", "label": "Ingress"},
    {"name": "body",    "type": "richtext", "label": "Brödtext"},
    {"name": "featured_image", "type": "image", "label": "Omslagsbild"}
  ]
}
```

The preset writes an ordinary, editable `item_template_blocks` tree with
breadcrumbs, title/date, body, and a server-rendered outline. Localize labels
or change field mappings in the collection template editor.

**Field name rule:** ASCII only, lowercase, `[a-z][a-z0-9_-]*`. `ä→a`, `ö→o`, `å→a` for the `name`; the `label` can be anything.

### 2. Seed with real content

```
create_collection_item collection="blog" status="published" fields={
  "title":   "Vår designfilosofi",
  "slug":    "var-designfilosofi",
  "published_at": "2025-05-15",
  "author":  "Anna Lindström",
  "excerpt": "Vi tror på enkelhet med syfte — varje beslut ska kunna motiveras.",
  "body":    "<p>Lång brödtext här...</p><h2>En underrubrik</h2><p>Mer text...</p>",
  "featured_image": "https://cdn.typeroll.com/..."
}
```

If `featured_image` is a URL from elsewhere, upload it first via `upload_media_from_url` and use the returned CDN URL.

Each published item with this collection's `route_template` automatically becomes `/blog/{slug}` at deploy time — you do **not** need to call `create_page`.

### 3. Build the native listing page once

```
create_page title="Artiklar" slug="blog" status="published" content_mode="blocks" blocks=[
  {"id":"articles-heading","type":"core/heading","data":{"text":"Artiklar","level":"h1","size":"auto","align":"left"}},
  {"id":"articles-list","type":"core/collection_list","data":{"collection":"blog","sort_by":"published_at","sort_order":"desc","item_block":"core/post_card","layout":"grid","cols":3,"gap":"md"}}
]
```

The list resolves from current collection data on every preview/build. No
generated HTML marker or regeneration call is needed.

### 4. Update the header partial to link to the listing

```
read_partial partial_id="header"
replace_partial partial_id="header" html_content="<updated with /blog link>"
```

### 5. Preview a single article

```
get_preview_link collection_name="blog" item_id="<id>"
```

The returned URL renders the native item block tree from current database content.

### 6. Deploy

```
trigger_deploy
get_deploy_status job_id=<id>
```

The build produces one HTML file per published article at `/blog/<slug>` plus the listing at `/blog`, and includes them all in `sitemap.xml`.

## Adding a new article later

```
create_collection_item collection="blog" status="published" fields={ ... }
trigger_deploy
```

Two calls. No per-article `create_page`, listing regeneration, or HTML diffing.

## Pitfalls

- **Don't fall back to "one page per article".** Collection item routes keep
  design, sitemap, preview, and nested URL handling centralized. `create_page`
  rejects slashes in `slug`; use the collection's `route_template`.
- **Slugs must be unique within the collection.** An item whose route tokens
  are missing cannot receive a static detail URL.
- **Don't use non-ASCII field names.** `datum` not `Datum`; `forfattare` not `författare` in the `name`. The `label` is free-form.
- **Template too clever.** First compose current native blocks and run the
  composition preflight. Use custom/HTML-backed behavior only when it is
  genuinely business-specific, not to repair a generic Core gap.

## When you want a page that ISN'T a collection item

A normal `create_page` is still right for:
- The blog's about/contact pages.
- Editorial standalone features.
- Anything that doesn't fit the "list of dated entries" mould.

Just don't use `create_page` *for the entries themselves*.
