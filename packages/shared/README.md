# @typeroll/shared

The data contract between the portal and the site renderer. Pure TypeScript with no runtime code.

## One Page model

Core 0.2.0 and MCP 0.45.0 use one content entity: **Page**. Every article,
checklist, product, directory entry and ordinary page uses the same API, editor,
blocks, history, preview and status. `content_type` selects a schema, URL pattern
and default Page template. Custom values belong in `fields`; title, slug, path,
body, SEO and status are built-in Page properties. Use `page_ref`/`page_ref_list`
for references and a blank type route pattern for records without detail URLs.

Use `create_page`, `list_pages content_type=...` and the Content type/Page template
tools. Use the Page ID and the same site `version` throughout editing, references,
previews and builds. Existing installations must migrate before running this
release. See the [model guide](https://typeroll.com/docs/tools/content-types/) and
[upgrade procedure](https://typeroll.com/docs/guides/unified-pages-upgrade/).

## Contents

- `src/types.ts` — every persistent document type (Organization, Site, Page, Block, Form, etc.) plus the `paths` helper that produces canonical resource addresses.
- `src/defaults.ts` — `defaultSiteSettings` and the `slugify` helper.
- `src/index.ts` — re-exports.

## Adding a new doc type

1. Add the TypeScript interface to `src/types.ts`.
2. Add `paths.xxx(...)` helpers at the bottom of the file. Convention: a function per resource name (e.g. `paths.pages(orgId, siteId)` for the collection, `paths.page(orgId, siteId, id)` for one doc).
3. Both backends consume the same path strings — Firestore uses them as document/collection refs, the fixtures backend treats them as filesystem paths.

## Important constraints

- **`id` is never stored.** It's the doc filename (fixtures) or the Firestore snapshot id, injected on read by the datastore wrapper. Don't add `id: string` to a write payload — and if you must round-trip a fetched doc, the store's `setDoc` will strip `id` for you, but be explicit about it in new code.
- **No runtime deps.** Other packages import types from here and the path helpers. Don't import runtime libraries.

See the root [`AGENTS.md`](../../AGENTS.md) and [`docs/`](../../docs/) for the
bigger picture.
