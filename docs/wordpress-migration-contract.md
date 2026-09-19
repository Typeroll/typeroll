# WordPress migration contract — Core 0.2.6

The importer preserves content and shared identity. It does not automatically
redesign a site or send every page to an LLM. Presentation is a separate,
reviewable Page-template decision. The public guide and MCP recipe describe
the same contract for Cloud and self-hosting.

## Extraction and mapping

1. Require the organization's verified import storage before starting.
2. Inventory source URLs and discover post types. Fail on inaccessible type or
   taxonomy endpoints rather than quietly dropping data. Helper 0.3.2 adds
   authenticated, paginated shared-term extraction; standard REST is supported.
3. Infer custom fields across imported records, preserve the actual REST base,
   and reject conflicting field shapes for explicit mapping.
4. Import each public taxonomy as a Content type. Import its terms as Pages,
   preserving archive paths, parents, available metadata and stable source IDs.
   Referencing content types get `page_ref_list` fields. Category names, emoji
   and ordering belong to the category Page, not editable article copies.
5. Validate membership, parent chains, primary category and identity/path
   conflicts before body writes. Do not guess a primary among multiple terms.
6. Restore lazy media, transfer required files to verified storage, rewrite
   references, and deterministically convert cleaned bodies to native blocks.
   Preserve manual order, page hierarchy and source paths. A failed required
   transfer stops the item; successful transfers remain reusable on retry.
7. Create imported Pages in Review using stable IDs. Repeating an import skips
   existing source-owned Pages and preserves later edits. This is recovery, not
   source synchronization. Schema or source-identity conflicts require review.

The converter reports HTML exceptions. Interactive WordPress markup needs a
configured Form/Extension and functional verification. Theme CSS, source scripts
and arbitrary ACF relationship semantics are not automatically ported. Complex
unknown values remain reviewable data; do not claim they are normalized refs.

## Presentation and acceptance

Categories and tags are ordinary Pages with editable block bodies, not virtual
archive-only records. Scaffold a title, the source term description and a reverse
reference listing; authors can add unique content around that listing. A Page
has one structural parent for breadcrumbs, but can reference several categories
and tags. Tag membership never changes that parent. Preserve explicit source
page parents; otherwise use an unambiguous or declared primary category.

Hierarchy and routing are separate. `parent` supplies the breadcrumb ancestry;
the Content type route template or explicit `path` supplies the URL. In a
migration, retain source paths even when they do not follow the new parent tree.
Do not silently append category or tag slugs to established article URLs.

Native headings offer an editorial scale and optional font weight. The generated
TOC has plain/numbered lists and a mobile visibility setting; it derives links
from current headings. Block defaults also apply to imported instances and
repeater cards, including image aspect ratios and visibility flags.

Compare representative articles, an archive and home page with source screenshots
at desktop and mobile widths. Review fonts, heading sizes, content width, card
layout, breadcrumbs, media, TOC and integrations. Scroll through the article;
check heading gaps after media, TOC clearance below sticky headers, anchor
landing positions and related-card grouping inside the intended column.
Core 0.2.7 adds opt-in `rhythm: "article"` on the body slot and
`appearance: "card"` on Post Cards. Use native template composition for these
choices rather than adding corrective CSS to individual imported pages. Retain
intentional improvements
(such as responsive video) and document deviations.

The launch report requires deploy-bound URL and SEO evidence plus fidelity
review (`desktop`, `mobile`, `shared_data`, `integrations`, `evidence`). These are
review attestations, not an automatic screenshot score. Missing fidelity evidence
keeps `launch_ready=false`; an HTTP 200 does not prove fidelity.

## Existing flattened imports

Do not rerun the new importer over existing edited content. Prepare a dry-run
mapping from legacy category fields to existing category Pages, preserving IDs
and URLs. Detect conflicting names/icons and missing memberships. Migrate
references, shared templates and schemas together, then remove the duplicated
fields. Keep body conversion scope separate from metadata normalization.

A shared-metadata repair can affect articles outside a selected body-conversion
sample. Keep that scope explicit: normalize only references and schemas, leave
other bodies intact, and obtain the deployment/data-change approval required by
the installation. Images do not need to move merely because category fields
become references. Preserve a rollback copy before applying a reviewed repair.

## Evidence

Run focused workflow, taxonomy, media preservation and launch-report tests; the
shared renderer tests; `php wp-helper-plugin/tests/taxonomies.php`; browser
`article-layout.spec.ts`; then `node scripts/oss-release-check.mjs`.
The regression tests must reject the previous workflow/renderer. Production
cutover also requires source-specific screenshots and live integration checks.

## Source-first prototype gate (Core 0.2.25 guidance)

Before bulk body or template writes, complete the shared
`tr-migration-evidence` MCP skill. It defines one source baseline and evidence
record used by WordPress, Astro, URL and multisite migrations. Measure source
fonts, panels, geometry and interaction states; a partially migrated target is
not a design reference. Prove a saved prototype for every active template and
its overrides, reading back exact supported fields and comparing real output.
A native block name or preserved unknown property does not prove support.
Missing capability is `waiting_for_native_support`, not tenant-specific CSS.

Record source/target URLs, actual viewports, top/scrolled screenshots, expected
and actual measurements, read-back values, reviewer and exact publication.
Keep visual judgment separate from HTTP/overflow checks. Invalidate affected
acceptance after template/theme changes. Existing fidelity booleans remain
attestations; this release does not add an automated visual score or independently
verify screenshot contents.

Historical PDF/image addresses and their bytes are separate requirements.
Assess redirect intent and expanded provider artifact limits; do not exclude
source 404s or redirect whole archive families without a reviewed decision.
Inventory each market's actual business flow, with authorized synthetic tests
and safe recipients. Loading, interaction and delivery have separate results.
No domain/DNS cutover is implied by creating or inventorying a site.
