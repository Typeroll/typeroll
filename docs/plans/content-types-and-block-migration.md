# Unified pages and block migration

## Outcome (updated decision)

There is one content entity: Page. Every page belongs to a Content type, which
owns its field schema, URL pattern and default template. Collections and
collection items are removed, including their separate UI, API, MCP and runtime
storage paths. There is no compatibility layer. Existing sites will be migrated.

Canonical pages retain the existing page body, SEO and publication contracts.
Custom type fields live on `Page.fields`, and `Page.content_type` identifies the
type. Type definitions live in the version's `content_types` namespace. URL-less
content is a page whose type does not generate a route, not a separate entity.
The migration resolves ID collisions, references, working copies, revisions,
version deltas and tombstones, and preserves public URLs and settings. Source
legacy data is read only by the migration tool, never by the new runtime.

The release is a coordinated breaking change. First prove the migration on an
isolated copy, then qualify the new runtime on staging; migrate production and
roll out its matching runtime in an approved maintenance window. Keep a verified
backup and a rollback procedure. Do not ship a half-migrated runtime.

## Delivery sequence

1. Extend native content blocks (tables, lists, images and heading outlines) and
   verify static repeaters retain authored card data.
2. Consolidate all content into Pages and Content types, with one rendering,
   working-copy, API/MCP and editor path.
3. Unify the Pages list and content-type navigation; remove Collections.
4. Improve HTML conversion: preserve anchors, links, captions, image dimensions,
   nested content, tables and videos. Report named HTML exceptions explicitly.
5. Verify a migration candidate against 20 representative articles, a listing
   and the homepage before converting the remaining content. Preserve original
   URLs and media aliases, restore curated related content and responsive CTAs.
6. Update public UI/API/MCP guides, run release gates and qualify Cloud staging.
   Production release and production content writes require exact approval.

## Acceptance evidence

- Desktop and mobile previews and generated static output agree.
- Every expected article is reachable from listings; authored static cards have
  titles and links. No horizontal page overflow on mobile.
- A block edit can be saved, previewed, undone and isolated in a site version.
- Migrated HTML bodies remain readable; URL-less types remain usable as data.
- Conversion reports unsupported structures without silently deleting content.
- Tables retain header/cell semantics; image credits and legacy anchors survive.
- One-off integration widgets may use a named HTML/embed exception. Ordinary
  text, lists, tables, images and video use native blocks.

## Scope boundaries

Content type, taxonomy, hierarchy and version are separate concepts. Forms
require a functioning runtime connection; converting markup does not activate
an external integration. Existing unavailable source videos are content issues,
not a reason to invent replacement media. Source-site overflow is not preserved.


## Local verification on 2026-09-15

The native Page model, type/template API and MCP tools, editor, offline migration,
WordPress import and static renderer are implemented locally. Core is 0.2.0,
MCP 0.45.0, data schema 2. No old content API/storage compatibility path remains.
The final local public release gate passed, including the media-boundary changes:
128 infrastructure tests, 1,988 portal tests, 480 shared tests, 130 MCP tests,
documentation checks, dependency audit, typechecks and complete builds.
Preview media authorization now resolves only referenced identities; publication
rejects unresolved private media URLs. Its guard test was falsified and restored.

Local browser tests passed at 390 and 1440 px: one Pages list, content-type filter,
type changes preserving Page identity/body/path/status, rejection of missing
required target fields, and completing those fields in the editor. A separate
browser test verified responsive listing tracks in preview and a fresh static
build. The required-field test was falsified by disabling enforcement, observed
to fail, then restored and passed.

The real WordPress extraction step now has tests for Pages and posts in both
content modes on a non-main branch. It preserves main, creates native content
types/templates, converts a WordPress table figure to a table block and keeps
heading anchors. Additional tests cover normalization collisions in ACF/meta
fields without overwriting built-in Page metadata.

The read-only Moveria candidate rendered 20 articles, its homepage and listing
at both widths without missing blocks or horizontal overflow. This is not yet a
complete visual migration: site-specific layout, curated related links, listing
coverage and external integrations remain to be qualified. The local image audit
substituted verified public aliases for authenticated original URLs in memory;
that substitution is not evidence of the real publication path. Some image
loads still failed and need a public network check. No production content changed.

Before delivery: finish the site-specific candidate, rehearse whole-installation
backup/migration/rollback, qualify the matching runtime on staging and obtain
exact production cutover approval. The private Cloud runbook documents the
writer freeze and matched database/runtime rollback; it is not a runtime fallback.

## Documentation and starter verification on 2026-09-15

Current public guides, REST examples, MCP tool descriptions and bundled agent
recipes all use Pages, Content types and Page templates. The canonical internal
contract is `docs/content-model.md`. Historical Cloud plans are marked as
superseded for the old content model; migration and changelog history retain
legacy names only to explain the transition.

A contract check rejects removed tool/template/reference names in active guides
and rejects legacy content files in the native site fixture. It was falsified by
inserting an obsolete MCP instruction, then restored and passed. The built MCP
CLI generated a temporary project with all 18 current recipes and native Page
instructions. Public HTML, per-page text, `llms.txt`, `llms-full.txt` and sitemap
output were checked at the configured `/docs/` build destination. No Collections
guide or old docs subdomain remains in those generated resources.

The separate Extension starter documents the Page API and credential boundary;
its full check passed (frontend/provider builds, 10 tests, manifest validation).
The Cloud staging publishing-readiness script now creates typed Pages and cleans
them up before removing their Content type. It refuses schema 1 and has not run
against a hosted schema 2 installation yet. This documentation work does not
advance the Cloud release lock or imply that any site has been migrated.

## Sorting and template choices — verified locally on 2026-09-15

Content types now define default sorting and optional allowed template IDs.
Page templates remain independent presentation resources; Pages can select an
allowed alternative or inherit the type default. The editor saves template
choices and numeric Page order through the existing working-copy commit flow.
Server validation covers create, draft writes, commit, type changes, definition
restrictions and deletion of referenced templates.

Listings, previous/next links and typed API lists use the type order unless
overridden; manual order supports negative numbers, missing values sort last
and ties use Page IDs. Explicit ID lists keep their authored order. Preview
branch isolation and actual static output were tested.

The full OSS release gate passed after regenerating the MCP guide bundle:
128 infrastructure tests, 1,991 portal tests, 482 shared tests, 130 MCP tests,
docs/audit/typechecks and all builds including static smoke scenarios. Four
browser journeys passed at 390/1440 px, covering type changes plus template
restrictions, saved overrides, reset to default and clearing manual order.
Their screenshots were inspected; Content type forms now use stacked fields
and mobile touch targets. Template enforcement and inherited sorting checks
were both falsified, restored and passed. No remote publication or data
migration was performed. The remaining cutover requirements above still apply.
