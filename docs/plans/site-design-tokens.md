# Site design tokens

Status: implemented and locally verified on `codex/site-design-tokens`. Target: Core
0.2.106, MCP 0.45.80, template capabilities 0.54.0. Not released. The mobile
sidebar fix originally prepared in PR #82 / Core 0.2.105 is included in this
combined candidate; neither candidate has production approval.

## Contract

Palette names are stored verbatim in block fields and styles. Preview and static
output resolve them to CSS variables. Unknown values produce
`field_type_mismatch`; raw CSS colours remain explicit exceptions, reported by
lint. Never automatically replace content, URLs or unrelated numeric fields.
Typography and spacing use named scales, also in responsive block maps. Numeric
pixel overrides remain supported and visible as exceptions. Font roles are
heading/body/mono, with families configured only in site settings.

Lint scans Pages, partials, page templates, custom block types, site styles and
custom CSS. Findings include source paths and suggestions. It never blocks
launch or silently edits customer data. Exact palette matches can be migrated
only after a dry run; ambiguous matches require a role choice. Re-read before
writing, reject stale plans, preserve unrelated changes, and require the same
Organization, Site and Version throughout. Custom CSS suggestions require review.

## Delivery order

1. Shared token vocabulary, schema metadata, validation and renderer parity.
2. Palette-first editor and scale selectors; site settings for scales/font roles.
3. Read-only lint, migration dry run and explicit apply through API/MCP; launch warnings.
4. Public docs, tr-new-site, tr-brand, tr-starter-design, tr-migrate-wp,
   workspace workflows/design.md, workflows/migration.md, qa/checklist.md,
   brief/brand.md and decisions.md guidance. site-starter is generated from
   the MCP workspace templates, not maintained as a divergent copy.
5. Regression and browser tests, palette change in a synthetic version; read-only
   customer inventory and migration simulation counts. Live customer writes,
   republishing and platform production rollout require scoped approval.

## Evidence and limits

Source: bootingbots/ulvon-meta `launch-prep`, qa/typeroll-platform-feedback.md
section 34 and scripts/typeroll/color_tokens.py (read 2026-10-26). Existing script
makes project-specific semantic choices, including deliberately retained white
hero text. General migration must not infer those choices from hex equality.

Before/after customer numbers must distinguish simulated replacements from
applied changes. No claim that a palette controls all hand-written HTML/CSS can
be made until lint exceptions have been reviewed. Custom authored CSS remains
an escape hatch with documented exceptions in decisions.md.


## Verification on 2026-10-26

- The full `oss-release-check.mjs --release-artifacts` gate passed, including
  dependency audit, docs, all typechecks/tests, upgrade probes, frozen template
  and all builds. Tests include 254 infrastructure, 3,095 portal, 1,633 shared
  and 280 MCP cases. MCP tests were re-run after final recipe corrections.

- The local browser matrix passed 56 cases in Chromium, Firefox and WebKit.
  It covers palette changes at 375/768/1280px, the editor's stored token and
  explicit override controls, mobile site selection down to the last entry,
  card excerpt hit areas and responsive section padding.
- API checks cover settings persistence, version scoping and lint access.
  Shared tests cover named and responsive values, listing item overrides,
  template content slots, field warnings, CSS injection and audit ambiguity.
- Frozen-publication fixtures build a real Astro artifact with palette names,
  custom scales and the mono font. A scale change invalidates the render plan's
  global cache key. Renderer snapshot changes add variables and opt-in mono
  rules; existing numeric defaults are preserved.
- The starter was regenerated locally from the canonical workspace generator.
  Its separate public repository remains unchanged until a verified MCP release
  exists, as required by that repository's source-lock synchronization contract.
- A read-only inventory covered 14 accessible Sites in two Organizations.
  Customer exports and counts are not committed to this public repository.
  The deployed list-pages response omits page-specific custom CSS, so that
  inventory is partial. The new server-side audit includes that CSS. No customer
  writes, palette changes, publication or applied before/after migration occurred.

## Existing Ulvön findings

F16 (SEO suffix persistence), F22 (post-card excerpt click area), F27 (style IDs
mistaken for links) and F29 (responsive section padding) are already in Core
0.2.104 / capabilities 0.53.0. Static rendering fixes require a new site build;
portal upgrades do not rewrite existing artifacts. This candidate adds F33
(mobile site selector scrolling) and F34 (block palette values), together with
scale/editor/audit support. Re-run launch evidence against the actual new site
artifact rather than removing CSS workarounds based on the portal version alone.

Remaining release work: qualify the pull request, obtain scoped publication
approval, publish Core/MCP/docs, sync site-starter, pin and qualify Cloud staging,
then promote the approved candidate and measure affected journeys in production.
No existing customer content is automatically converted or republished.


## Later Ulvön follow-up in the same unreleased candidate

Historical behavior: the domain candidate workflow below is superseded by
[single-publication domain switching](single-publication-domain-switch.md).

PR #83 also addresses F35: normal publication stays on active/temporary hosts;
saved desired domains only take effect through explicit preparation of the last
published snapshot shortly before DNS changes. Waiting candidates release the
publication lock, and newer published content makes an older candidate outdated.
UI/API/MCP disclose the destination and frozen noindex state before cutover. See
`../ulvon-migration-feedback.md` for all later wishlist outcomes, source-media
archive guidance, the local ICC helper and release boundaries.
The mobile drawer retains a separately visible sign-out/account area while its
pickers and navigation scroll together; list tests do not assume no other Site
fixtures exist in the same Organization.
