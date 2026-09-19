---
name: tr-migration-evidence
description: Source-first design baseline, native capability mapping and evidence gates required before bulk website migration or visual acceptance.
---

# Migration evidence contract

Use this shared contract with WordPress, Astro, URL and multisite recipes.
Default to preserving the source appearance and behavior. A redesign requires
explicit scope. A partly migrated target is not the design reference.

## Gate 1: source baseline, before conversion

Record the authoritative source URL/date, scope, relevant Core version, active
Page templates and overrides. Inventory home, category/archive, long/short
articles, downloads, empty related lists and each distinct business surface.
Capture screenshots and computed geometry at matching actual `innerWidth`
values (320/390/768/1024/1280/1536 where relevant, plus both sides of actual
breakpoints). Record loaded font families/weights, color panels, logo/header,
hero, gutters, article/sidebar widths, card anatomy/grid and footer. Inspect
loaded images, menus, scrolled TOC, anchor landings and long links.

Before removing builder wrappers/classes, preserve the information they carry:
anchors, lazy/srcset/background images, captions, tables, ordering, downloads,
embeds and interactions. Content modernization is a separate decision.

## Gate 2: one verified prototype per active recipe, before bulk writes

Call `list_block_types` and `read_block_type` on the deployed runtime. Map each
source component to exact fields/bindings, defaults, minimum version and expected
geometry. A registry entry does not prove the capability works. Save and read
back each prototype, then inspect its preview and an authorized static build.

Example: a 48px heading uses `core/heading.font_size_px: 48` on Core 0.2.25+;
read the saved block back and measure computed `fontSize` at 1280px. Writing
`font_size_px` to `core/prose`, which does not declare it, is an unsupported
mapping even if an API preserves that unknown key. Stop with
`waiting_for_native_support` when required capability is absent or ignored;
do not hide the gap with tenant CSS or generic custom blocks.

Validate shared Page references, item order, missing images and empty/unpublished
references. Keep semantics separate from presentation: category emoji belongs
to its shared Page field, not copied into every article or card excerpt.
Do not apply a template to hundreds of Pages until its prototype passes.

## Separate files, addresses and business behavior

Inventory both file bytes and every discovered historical asset URL, including
PDF/download hrefs, image click targets, srcsets and backgrounds. Verify transfer
and rendering separately from old-address preservation. Deduplicate by content
identity, not similar filenames. Preflight expanded redirect artifact bytes and
provider rule limits. A 200 at an unrelated destination is a failure. A source
404 is not permission to discard a URL with traffic/backlinks: record a decision.
Query URLs need explicit routing support at the future host; keeping the old
server does not preserve them when the same hostname moves.

Classify each CTA: contact form, owned lead workflow, affiliate link, partner
iframe/script or other runtime. Preserve market, language, destinations and
attribution. Never clone recipients or partner IDs across markets. Test loading,
interaction and conversion separately; only use an authorized synthetic mode and
safe recipient. Unavailable delivery remains UNVERIFIED. No real leads or mail
to third parties merely to fill a checklist.

## Evidence record (repeat per recipe, viewport and state)

- Source URL/date and target URL; Page/template IDs; exact publication ID.
- Runtime/Core version and saved content/config revision.
- Actual viewport `innerWidth` and height; scroll/menu/anchor state.
- Source and target screenshot paths; measured expected and actual geometry.
- Capability mapping: block type, field, read-back value and computed result.
- Separate PASS / FAIL / UNVERIFIED for routing, content, visual, assets,
  keyboard/interaction and delivery; reviewer and timestamp.
- Visible deviation, specific user benefit, accepted scope and rationale.

Filled examples:

| Observation | Technical result | Visual decision |
| --- | --- | --- |
| Source video overflows a 390px viewport; native video fits and shows the entire frame | Width 390px, original aspect preserved; captures reviewed | PASS: deliberate improvement in mobile usability |
| Source has four cards and turquoise hero at 1280px; target has three plain cards and no color panel | HTTP 200, no overflow, all content is blocks | FAIL: brand/layout lost; those technical facts cannot attest visual fidelity |
| Heading round-trip retains 48 but computed size stays 32 | Save succeeds | FAIL: find ignored field/cascade before bulk conversion |

Keep imported, saved, locally checked, hosted-preview checked, published and
traffic-cut-over distinct. Template/theme changes invalidate affected acceptance;
never attach old evidence to a new publication. `record_migration_seo_acceptance`
booleans are reviewer attestations, not automated visual proof. Do not set them
from HTTP status, native-block count or overflow alone. Report a completed
pre-cutover scope honestly when DNS or integrations remain out of scope.
