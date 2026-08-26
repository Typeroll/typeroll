# @typeroll/shared

The data contract between the portal and the site renderer. Pure TypeScript with no runtime code.

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
