# Unified Page content model

This is the current Core 0.2.0 / MCP 0.45.0 development contract. It requires data
schema 2. Availability in Typeroll Cloud depends on the matching runtime and
completed data migration; the version bump alone does not migrate installations.

## Entities

| Entity | Owns |
| --- | --- |
| Page | Stable site-wide ID, title, slug, explicit path, body blocks or HTML, SEO, publication status, dates, custom `fields`, `content_type`, history and working copies |
| Content type | Custom field schema, URL pattern, optional default Page template, sorting and facets |
| Page template | Reusable block layout containing `template_content_slot` for the Page body |
| Partial | Shared header, footer or reusable content fragment |

Articles, checklists, products and directory entries are Pages. There is one
storage namespace, editor, API, MCP tool family and rendering path for all of them.
The standard type is `page`. A type's empty route pattern permits data records
without detail URLs. Content type, taxonomy, parent hierarchy and version are
independent choices.

## Storage and ownership

Within `organizations/{org}/sites/{site}/versions/{version}`:

- `pages/{pageId}` stores the Page, with custom values under `fields`.
- `content_types/{name}` stores the type definition.
- `page_templates/{templateId}` stores the shared layout.

Branches inherit from their base and materialize only changed resources. Working
copies and history belong to the same Page identity and selected version. Do not
create duplicate stores for different content types. Media identities and bytes
are shared across site versions and do not move during the content-model migration.

## Contracts

Use `create_page`, `read_page`, `list_pages`, `update_page`, `replace_page` and
`delete_page`. Filter lists with `content_type`; pass a Page ID to block, preview,
reference and working-copy operations. Use the Content type and Page template
APIs for definitions. REST endpoints are listed in [the API reference](v1-api.md).

Common title, slug, body, SEO and status are built-in Page fields. A Content type
must not redefine them as custom fields. `page_ref` and `page_ref_list` store Page
IDs and can declare `ref_content_type`. Fields with `rendered: false`, undeclared
fields and private provenance are excluded from public rendering.

Page template bindings use `page.*`; repeaters expose their current Page or static
row as `item.*`. `item` in this rendering context is not a second persisted entity.
Listings use `core/page_list` or `core/repeater` with `source_type: "pages"`.
Dates default to the Page's `date_published`.

A deliberate `change_page_content_type` keeps Page identity, body, status and its
existing address; the full target `fields` object is validated, including required
fields. Save/discard an existing working copy first. Removed values survive in
revision history. Page content edits require a save; definition changes save
immediately. Use the same `version` for every operation in a redesign.

## Migration and documentation

There is no runtime compatibility layer for the removed Collections API or item
storage. Old shapes are read only by the offline migration. It preserves routes,
references, versions, tombstones, working copies and revisions; operators must
freeze writers and retain a verified backup before applying it.

See [upgrade instructions](../packages/docs-site/src/content/docs/guides/unified-pages-upgrade.mdx),
[Page compositions](page-compositions.md) and the
[public model guide](../packages/docs-site/src/content/docs/tools/content-types.mdx).
Historical changelog entries describe the releases they belonged to and must not
be used as current API instructions.

Keep UI, API, MCP descriptions, bundled agent guides, `typeroll init`, native seed
fixtures, public docs and Extension-starter integration examples aligned with this
contract. Public HTML and agent text exports are generated from the same sources.


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
