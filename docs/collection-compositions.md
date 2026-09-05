# Native collection compositions

Collection item pages should use `item_template_blocks` unless the content
genuinely needs behavior the block system cannot express. Core ships two
long-form starters in addition to the existing blog, team, event, product,
and custom starters:

- `article`: breadcrumbs, title, date, rich-text body, and a server-rendered
  heading outline in responsive columns.
- `checklist`: breadcrumbs, title, an optional PDF button, rich-text body, and
  previous/next navigation with explicit field overrides.

Choose one in the portal's collection wizard or pass `template_kind` to the
v1 API/MCP `create_collection` call. The resulting block tree is ordinary
editable content; labels and field mappings can be localized or changed after
creation.

```json
{
  "name": "articles",
  "label_singular": "Article",
  "label_plural": "Articles",
  "route_template": "/articles/{slug}",
  "template_kind": "article",
  "fields": [
    { "name": "title", "label": "Title", "type": "text", "required": true },
    { "name": "slug", "label": "Slug", "type": "text", "required": true },
    { "name": "body", "label": "Body", "type": "richtext", "required": true },
    { "name": "published_at", "label": "Published", "type": "date" }
  ]
}
```

## Native bindings and server output

Block schema fields of type `text`, `textarea`, `url`, `image`, `file`, or
`email` accept an exact context binding such as `{{item.pdf_url}}`. The value
keeps its native type until final escaped substitution. Bindings embedded in a
larger string are not evaluated. A missing value becomes an empty string; wrap
optional controls in `template/show_if` so they do not leave a dead link.

The collection template blocks have these field-aware contracts:

- `template/item_body.field` selects the rich-text item field and preserves
  its safe HTML through the final sanitizer.
- `template/item_image.field` selects the image item field.
- `template/page_date.field` reads the selected item field on collection pages
  and the selected page field elsewhere.
- `core/table_of_contents.source_field` extracts `h2`–`h4` from that field,
  emits links in the initial HTML, preserves unique existing heading IDs, and
  assigns deterministic IDs where needed. An empty outline is hidden.
- `template/page_breadcrumbs` emits an ordered, semantic trail in the initial
  HTML. Page routes use their parent chain. Item routes include Home, the
  collection root, an optional generated single-facet taxonomy route, and the
  current item. `home_label` and `aria_label` are editable/localizable.
- `template/item_navigation` normally follows the collection's `sort_field`
  and `sort_dir`. Set `previous_url_field`, `previous_title_field`,
  `next_url_field`, and `next_title_field` to use explicit imported neighbor
  fields instead. Missing neighbors emit no visible or focusable link.

`style_overrides.custom_css` is bundled for every nested block instance in
both preview and static builds. It remains an escape hatch, not the expected
way to repair generic spacing, wrapping, responsive, focus, or empty-state
behavior; those belong in Core defaults.

## Native archive and partial compositions

Use `getArchiveCompositionStarter` when a migration or integration generates
an archive page. It returns semantic breadcrumbs, one `h1`, and a responsive
`core/collection_list` with one, two, and three columns at the mobile, tablet,
and desktop breakpoints. Configure `item_overrides` on the listing to map the
collection's title, excerpt, image, image-alt, date, author, link, and optional
download fields into `core/post_card`.

`core/post_card` emits a configurable `h2`, `h3`, or `h4`; keeps the title and
optional download as separate actions; uses the mapped alt text; and omits the
entire image element when no image exists. Do not patch empty media with CSS.

Use `getPartialCompositionStarter('header' | 'footer', …)` for a native
starting tree. It combines `template/site_logo`, layout blocks, and
`core/navigation`. Navigation is present in the initial HTML, includes a
localized landmark label and exact `aria-current="page"`, remains usable
without JavaScript, and progressively enhances to a keyboard-accessible mobile
disclosure. Cookie consent remains a site setting rather than footer markup.

Responsive schema fields use breakpoint values directly in block `data`:

```json
{
  "type": "core/collection_list",
  "data": {
    "collection": "articles",
    "cols": { "mobile": 1, "tablet": 2, "desktop": 3 }
  }
}
```

Do not send a top-level `responsive` member on a block. The v1 routes reject
that ambiguous shape and point to `data` or the MCP `set_block_responsive`
tool.

## Safe page-mode switching

`PATCH /pages/{pageId}` deliberately rejects `content_mode`. Save the target
tree first, then use the revision-aware mode endpoint and verify its response:

```http
PATCH /sites/{siteId}/pages/{pageId}
Content-Type: application/json

{ "blocks": [ ... ], "save": true }
```

```http
POST /sites/{siteId}/pages/{pageId}/mode
Content-Type: application/json

{ "to": "blocks", "convert": false }
```

The MCP equivalent is `update_page` followed by `set_page_mode`.
`batch-write` also reports `content_mode` as a per-row error rather than
silently ignoring it.

## Review dependencies before a migration build

Pass proposed compositions to migration preflight before writing pages or
templates:

```http
POST /sites/{siteId}/migration-preflight
Content-Type: application/json

{
  "source_url": "https://old.example.com",
  "compositions": [{
    "id": "article",
    "name": "Article",
    "fields": [
      { "name": "body", "type": "richtext" },
      { "name": "pdf_url", "type": "url" }
    ],
    "blocks": [ ... ],
    "business_specific_block_types": []
  }]
}
```

The response keeps the infrastructure checks and adds
`composition_reviews`, `compositions_ready`, `infrastructure_ready`, and the
actual `template_capabilities_version`. Each review lists required/missing
block types, item fields, capability flags, business-specific blocks, and
workaround debt. Missing dependencies, raw HTML, corrective per-instance CSS,
or an undeclared generic custom block produce `waiting_for_native_support` and
make top-level `ready` false. The check is read-only.

Treat `requires_hosted_verification: true` literally: source capability and
preview tests do not prove the production builder. Once the required release
is deployed, rerun the clean fixture in preview and in a fresh hosted static
build before replacing transitional tenant components.
