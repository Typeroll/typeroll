---
name: tr-page-template
description: Create or edit a reusable Page template for articles, checklists, products, directory entries or other Pages that share a layout.
---

# Share a layout across Pages

Read capabilities, available block types, content types and Page templates first.
Use a site version for substantial design changes. The Page owns its body blocks;
the template owns the shared layout around that body. The content type selects a
default template, and an individual Page can override it.

1. `create_page_template name="article-layout" label="Article" starter="article" status="published"`.
   Alternatively supply `blocks` instead of `starter`. Presets include article,
   blog, checklist, team, events, products and custom.
2. `update_content_type name="articles" patch={template:"article-layout"}`.
   For a single-page override, `update_page page_id=... patch={template:"article-layout"} save=true`.
3. Read and edit the template through `read_page_template` or block tools with
   `target: { kind: "template", id: "article-layout" }`. Template edits save
   immediately; content-type and template changes are isolated by `version`.
4. Keep a `template_content_slot` where the Page's body belongs. Its `max_width`
   can be full, narrow, normal or wide. Use native columns/containers for layout.
5. Metadata blocks include `template/page_title`, `template/page_date`,
   `template/page_featured_image`, `template/page_breadcrumbs` and
   `template/page_navigation`. The outline block reads the rendered body headings.
6. Use `{{page.title}}` or `{{page.custom_field}}` in template bindings.
   A repeater's children use `{{item.title}}` for the current listed Page.
   Custom fields can be typed objects, arrays or Page references; preserve those
   structures instead of storing hand-generated list HTML.
7. Preview several Pages using the template: long title, short body, missing
   optional image, populated reference list. Inspect desktop and mobile output.
   Verify the authorized static build as well as the live database preview.

Prefer native image, table, list, heading and content blocks. A rare specialized
widget can use a reviewed HTML/embed block. Reusable custom behavior belongs in
one custom block type rather than repeated HTML bodies. Existing HTML-mode pages
may share fragments through partials and `<x-include>`, but use block templates
for new content families.

Header/footer partials are global and remain separate from content types. Keep
site-level design tokens in settings and shared layout changes in the template.
Page body edits stay specific to that Page. Read the template before mutation;
never replace it with a starter merely because an import is being retried.


Content types also own `sort_field`/`sort_dir` and optional `allowed_templates`.
Types define content; templates define presentation. Multiple compatible Page
templates can be allowed, with `template` selecting the default. Null/absent
`allowed_templates` is unrestricted, `[]` allows none, and a configured default
must be in an explicit allowed list. Page overrides must be allowed; null/empty
`Page.template` restores inheritance. Page template changes use Save/Discard.

Listings inherit type sorting unless explicitly overridden. `Page.sort_order`
is the manual numeric order; null clears it. Missing sort values come last and
IDs break ties. Explicit ID lists keep their order. Typed `list_pages` queries
inherit type sorting and accept `sort_by`/`sort_order`; unfiltered API lists
default to stable IDs. See the public Content types guide for editor steps.

## Structured fields without empty labels

Check `supports_page_field_list` before adding `core/field_list`. Configure
`data.fields` as `{ field, label? }` rows, optional `title` and `layout`
(`stack` or `two-column`). It omits empty rows and an entirely empty section,
respects `rendered: false`, uses select display labels and links Page references.
Zero and false are real values. Optional row `html` has only `{{label}}` and
`{{value}}` slots; row `css` contains declarations, and `css_class` supports
shared selectors. Values stay in Page.fields; never duplicate them into rich text.
Read the current block schema and content type, and verify preview before publishing.

For checkbox lists, `item_html` decorates each selected option with the same
label/value slots (for example a check icon). `item_links: [{ value, url }]`
links only chosen stored options to listing URLs, retaining their schema labels.
Style list items via the row css_class and normal block Custom CSS.
