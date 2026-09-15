# Native Page compositions

Core 0.2.0 uses one Page model. Content types define custom fields, route patterns
and default Page templates. Existing installations require the schema 2 migration;
no Collection or item API remains in the runtime.

## Article and checklist templates

Create a Page template with `create_page_template` or
`POST /api/v1/sites/{siteId}/page-templates`. The `starter` can be `article`,
`checklist`, `blog`, `team`, `events`, `products` or `custom`. The resulting block
tree is editable. Assign its ID to the content type's `template`.

```json
{
  "name": "article-layout",
  "label": "Article",
  "starter": "article",
  "status": "published"
}
```

Create the type separately with `create_content_type`:

```json
{
  "name": "articles",
  "label_singular": "Article",
  "label_plural": "Articles",
  "route_template": "/articles/{slug}",
  "template": "article-layout",
  "fields": [{ "name": "excerpt", "label": "Summary", "type": "textarea" }]
}
```

Create content using `create_page` with `content_type: "articles"` and custom
values in `fields`. Title, body blocks, dates, SEO and status are Page properties;
do not duplicate them in the custom schema.

## Rendering

- `template_content_slot` renders the Page's body blocks.
- `template/page_title`, `template/page_featured_image` and `template/page_date`
  read Page context; custom fields are available as `{{page.excerpt}}`.
- `core/table_of_contents` builds the outline from the rendered Page body.
  Authored fragment IDs survive conversion. The generated outline is available
  as `page.outline_html` to custom templates.
- `template/page_breadcrumbs` and `template/page_navigation` use the same Page
  source as listings. Navigation supports explicit imported neighbor fields.
- Within a repeater, `{{item.title}}` refers to its current Page or static row.
  It does not identify a separate content entity.

Custom fields with `rendered: false` and undeclared fields never enter public
rendering. Bindings must not be used to expose private editorial data.

## Listings and reusable layout

`getArchiveCompositionStarter` supplies breadcrumbs, a heading and a responsive
`core/page_list`. `getPartialCompositionStarter` supplies a header or footer.
These are ordinary block trees. Map custom image, excerpt and download fields
with `item_overrides`; dates default to the Page's `date_published`.

```json
{
  "id": "articles",
  "type": "core/page_list",
  "data": {
    "content_type": "articles",
    "cols": { "mobile": 1, "tablet": 2, "desktop": 3 },
    "sort_by": "date_published",
    "sort_order": "desc"
  }
}
```

Responsive values belong inside block `data`, never in a top-level `responsive`
member. Page references use `page_ref` or `page_ref_list` with optional
`ref_content_type`; related and backlink repeaters resolve the same Page IDs.

## Migration verification

Call `migration-preflight` before imports. Confirm customer storage, block
capabilities and every named HTML exception. Then verify preview and a fresh
static build: native source capability alone does not prove the hosted builder.
Use the same version for Page, template and type operations. Preserve addresses,
revision history, working copies, branch inheritance and tombstones during the
one-time migration; media objects do not need to move for this model change.
