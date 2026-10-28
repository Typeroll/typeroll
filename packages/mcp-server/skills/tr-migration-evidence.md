---
name: tr-migration-evidence
description: Choose text and design/image preservation independently, map standard and custom blocks, preserve old URLs, and verify content, design and behavior before migration acceptance.
---

# Migration evidence contract

**Who runs this:** this recipe is for the user's own AI agent (Claude Code, Codex or
another MCP client) working through MCP and the public API. The portal's built-in
AI assistant has no migration tools: it does not import, convert or verify sites.

Use this shared contract with WordPress, Astro, URL and multisite recipes.
## Choose the migration intent before writes

Record two independent choices in `brief/migration.md` (or the project's
corresponding brief): `text_intent` and `design_intent`, each `preserve` or `renew`.
Design includes images. These are planning labels, not migration API parameters.
Use the starter's `workflows/interview.md` when guidance or decisions are missing;
resume existing answers. Do not infer either choice from a vague "migrate" or
"renew", or silently apply an old single-choice brief to both dimensions.

| Text | Design/images | Acceptance |
| --- | --- | --- |
| Preserve | Preserve | Compare wording and appearance separately with the source. |
| Preserve | Renew | Keep wording; compare appearance with approved new prototypes. |
| Renew | Preserve | Review copy against the editorial brief; keep source appearance, allowing documented layout adjustments for new text length. |
| Renew | Renew | Review copy and appearance against their separately approved briefs. |

Preserved text includes headings, body copy, CTA labels and captions. Record
metadata, alt text, legal text and translation rules explicitly; SEO is not an
exception permitting silent rewrites. With renewed design, list required assets
and which images may be replaced or generated, including cropping, credits and
rights. Format/size optimization must not change a preserved image's motif.

Record source URLs, dates, approved scope, per-Page exceptions and acceptance
references separately. Both choices preserve facts, ownership, required behavior
and historical URL continuity. Renewing design does not authorize text rewrites;
renewing text does not authorize new imagery. Neither authorizes invented claims,
unreviewed content removal or domain cutover. Protect existing target edits.

## Use editable blocks for all four combinations

1. Inspect standard block schemas, composition starters, named styles and Page
   templates. Prefer these when they fit.
2. When they do not fit, read `tr-custom-blocks` and create a reusable Site block
   type with meaningful editable fields. Prefer a composition of standard blocks;
   a field-driven template type is appropriate when composition cannot express it.
   Validate the type, preview it, save/read it back and test a representative use
   in static output. Do not store a whole page as an opaque HTML field.
3. Raw HTML is a last resort for a small, exceptional fragment. Record the exact
   block/Page, why neither standard nor custom types fit, editing limitations and
   verification. Keep the surrounding page block-based whenever possible.

A justified HTML exception is a unique art-directed hero: layered imagery,
animation and text placed precisely over a background at different breakpoints.
Prefer a field-driven custom type when editors need to change its text, images
or links repeatedly; a one-off hero may remain an isolated HTML block. Verify
actual breakpoints, cropping, keyboard access, contrast and reduced motion. Keep
essential copy and links usable without animation. Do not copy source-platform
scripts; any custom script needs explicit scope and the supported runtime.

On Core 0.2.89 / MCP 0.45.69+, composition preflight accepts reviewed custom types in
`reviewed_custom_block_types: [{type, reason}]` and rare HTML blocks in
`reviewed_html_blocks: [{block_id, reason}]`. Inspect the deployed schema first on older installations. These are reviewer
attestations, not proof of quality. They only acknowledge those specific choices; missing
block types/fields and unreviewed workarounds still block readiness. Do not call
something business-specific just to bypass a check. A confirmed renderer bug
still needs a platform fix, not a disguised HTML/CSS workaround.

## Import is not block reconstruction

The managed WordPress importer deterministically stores cleaned HTML and shared
references, without AI rewriting. That is a source-preserving intermediate step.
The external agent rebuilds it into reviewed blocks/templates for all four combinations;
`set_page_mode` does not perform conversion. Keep the complete source, map every
in-scope content element, and do not silently truncate long pages. When text_intent is preserve retain wording; when it is renew track approved
rewrites and source facts, independently of design_intent.
An import finishing does not mean design, block reconstruction or launch is done.

## Old URLs must continue to work

Inventory public URLs from sitemaps, CMS records, internal links, pagination and
available traffic/backlink exports, including important assets and anchors.
Record each old URL as preserved or redirected to a relevant working destination.
Renewal may merge pages, but every old address still needs a meaningful mapping.
Never blanket-redirect to the homepage or mark public content `excluded` merely
to make coverage green. Private/admin/session noise can be excluded with a reason;
retiring a public URL requires a separately agreed exception to this contract.

Use `add_migration_urls` with `source_origin`, keep a per-URL mapping, and run
`verify_migration_urls` against the authorized deployed candidate, then
`get_migration_launch_report`. Check both slash forms, redirect chains/loops,
query routes and fragments with their actual routing mechanism. DNS is not an
HTTP redirect: changed hostnames need a host that continues serving redirects.
A missing route or a 200 at unrelated content fails continuity in either path.
Do not switch traffic until these checks pass and cutover is authorized.

## Gate 1: source baseline, before conversion

Record both chosen intents, authoritative source URL/date, scope, relevant Core version, active
Page templates and overrides. Inventory home, category/archive, long/short
articles, downloads, empty related lists and each distinct business surface.
For design_intent=preserve, capture source and target geometry; for design_intent=renew, compare the target
with the approved design while retaining source coverage evidence. Capture
screenshots and computed geometry at matching actual `innerWidth`
values (320/390/768/1024/1280/1536 where relevant, plus both sides of actual
breakpoints). Record loaded font families/weights, color panels, logo/header,
hero, gutters, article/sidebar widths, card anatomy/grid and footer. Inspect
loaded images, menus, scrolled TOC, anchor landings and long links.
Inventory semantic CTA anchors/buttons, downloads and affiliate links before
copying prose: retain decoded labels, href paths, query parameters, fragments,
`target` and meaningful `rel` tokens. A source CSS class may identify a CTA
whose appearance would disappear when copied into prose.

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
mapping even if an API preserves that unknown key. A new presentation may use
a reviewed custom type as described above. Missing or ignored declared behavior
is a platform defect: stop that recipe with `waiting_for_native_support` and do
not disguise the failure with tenant CSS.

Validate shared Page references, item order, missing images and empty/unpublished
references. Keep semantics separate from presentation: category emoji belongs
to its shared Page field, not copied into every article or card excerpt.
Validate actual field types, not just key names. A presentation field whose schema declares
`design_token` also accepts the named steps for that scale, including responsive maps
on responsive fields (Core 0.2.106 / capabilities 0.54.0). Otherwise number fields use JSON numbers
(`16`, `1.6`, `1`), not strings (`"16"`, `"1.6"`, `"1"`); booleans use `true`/
`false`. Check responsive map values too. Read-back retention is not enough:
measure the resulting font size, line height and paragraph spacing. If an
incorrect type is accepted but ignored, fix the prototype before bulk writes.

Map standalone CTAs to `core/button` when its declared fields preserve the
source behavior, rather than leaving class-dependent anchors in prose.
Core 0.2.25+ `new_tab: true` emits `target="_blank"` and
`rel="noopener noreferrer"` in static HTML; false/unset keeps the same tab.
Verify the rendered target/rel, preserved affiliate queries/fragments, keyboard
activation, actual tab opening and narrow-screen wrapping without requiring
JavaScript. Do not silently discard source `sponsored`/`nofollow`, download
behavior or other semantics unsupported by the chosen block: record the gap
and use a supported composition or stop for native support.
Do not apply a template to hundreds of Pages until its prototype passes.

## Distinguish custom presentation from platform defects

A new layout or reusable visual component is a legitimate custom block, not
necessarily a Core defect. Use the block hierarchy above. When a declared Core
feature fails, do not cover it with site/page CSS, raw HTML or a replacement
block. Record and report it. Check these five causes first:

1. **A platform default no setting reaches.** Compare computed text rendering
   and base styles on `body`, links and headings (`-webkit-font-smoothing`,
   `line-height`, `text-decoration`) with the source. If the difference comes
   from Typeroll's base CSS, check Site settings and the render versions first
   (`read_site_settings` → `render.upgrades`).
2. **A replaced control ignores the block's settings.** A capability can swap a
   field for a provider element (address suggestions). Compare that control
   with a plain field in the same block: border, radius, height, background,
   text colour, font, placeholder, icon and colour scheme in light and dark mode.
3. **A missing part.** The source has a part (icon, badge, second label) the
   block has no field for. Check `read_block_type` for a field before
   concluding it is missing.
4. **A value that is stored and ignored.** Read every write response's
   `warnings` (`field_type_mismatch`, `unknown_style_override`): a wrong type or
   key is saved and never rendered. Measure the computed result, not the
   read-back.
5. **Preview differs from the published page.** A setting that shows in preview
   but not in a fresh hosted build is a publication gap; report both URLs.

Report each gap with: site ID, Organization, Core version and render version;
source and target URL; viewport (actual `innerWidth`), browser and DPR; the
block ID and type or the setting; source and target computed values; what is
missing, ignored or wrong; the proposed setting or fix; and acceptance
criteria a reviewer can measure. State that no workaround CSS is in place.
Mark the affected recipe `waiting_for_native_support`, continue independent
work, and verify against the chosen acceptance reference after the release.

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

## Scripts, tracking and consent

Do not copy JavaScript from the source site. WordPress plugins and themes
inject their own runtime: jQuery, sliders, lightboxes, form and cookie
plugins, page builders (Elementor, Breakdance, Divi), emoji and AJAX calls to
`admin-ajax.php` or `/wp-json/`. It loads from, or posts to, a site that is
about to be switched off. Inventory every `<script>` on representative source
pages (head and body, inline and external, and which plugin or theme it
belongs to), then decide each one:

| Source script | Decision |
| --- | --- |
| WordPress core, theme or plugin runtime | Never copy. Rebuild what it did with native blocks, Forms or settings, or report a platform gap (see "Report platform gaps"). |
| Cookie plugin (CookieYes, Complianz, Cookiebot, Borlabs, …) | Never copy. Enable the site's cookie banner (`cookie_consent.enabled: true`) with Swedish or local text and the privacy policy URL. |
| Analytics or advertising tag in the Integrations catalog (GA4, GTM, Meta Pixel, LinkedIn, TikTok, Hotjar, Clarity, Pinterest, Snap, Reddit, X, Microsoft Ads, HubSpot, Plausible, Fathom, Matomo) | Carry over the ID only: enable the Integrations app with the source's ID (`list_apps`, `update_app`). Enable the cookie banner; analytics and advertising integrations wait for the visitor's consent. Never paste the vendor snippet. |
| Tracking tag the catalog does not cover | Only with the owner's approval, in `cookie_consent.scripts_optional` with the banner enabled. Never in `scripts_head`, `scripts_body_end`, `scripts_necessary`, pages or partials. |
| Partner widget or embed the page needs to work | Prefer a native block or an iframe from an allowlisted host. Keep custom code minimal, record why, and do not load it from the source site. |

Ask the owner to confirm the analytics IDs; never invent or reuse one from
another market. Before launch, `get_migration_launch_report` must show
`scripts.status: "clean"`: it fails on copied source-platform scripts
(`source_runtime_script`), tracking outside consent
(`tracking_outside_consent`) and analytics or advertising integrations without
the banner (`tracking_without_consent_banner`). In the hosted preview, check
that no request goes to the source host or `/wp-content/`, no tracking request
fires before consent, and the tags fire after "accept all".

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

## Complete census and visual signoff

The initial route census must combine source sitemaps, internal links, archive
pagination, CMS inventory and known utility routes. Include homepage, archives,
404/search behavior and routes outside the sitemap where present. Do not invent features absent from the source; include additions only in the agreed brief. Assign every route a recipe, template override,
composition or documented exception. Inventory the whole shell: content outside
`main`, header, footer, service navigation and archive heroes are not optional.

Derive required evidence from that census. For design_intent=preserve, pair every
in-scope source/target route at mobile and desktop; for design_intent=renew, compare
every target route to its approved prototype. Independently compare preserved text
to the source and renewed text to its editorial brief; account for the source
content/URL mapping in every combination; add each unique component, breakpoint and interaction
state. Inspect page-specific media, lists, tables, embeds, CTAs, anchors and related
content. One representative article cannot attest every article's content.

A coverage row records route, recipe, component, state, actual viewport dimensions,
source revision, target content/config/Core/publication revision, paired screenshot
references, reviewer, review time and result. All rows start `UNVERIFIED`.
Keep independent results for content, links, list cardinality, full membership,
sequence, appearance, keyboard behavior and delivery. Screenshots must be inspected;
image diffs and contact sheets assist review and do not prove aesthetics.

For menus capture source and target closed, open and scrolled states, nested groups
if present, short landscape, focus order, Escape, link activation and breakpoint
transitions. For TOCs capture top/middle/bottom and anchor landings. Include tabs,
accordions and empty/loading/error/success states where applicable. Separate mobile
and desktop menu compositions require separate evidence; shared links may be reused
but one variant's screenshots do not attest the other.

Report denominators separately: routes/content, paired visual pages, recipes,
components and states. Missing an archive, open menu, footer or a unique embed leaves
coverage incomplete even if all captured screenshots pass. Shared block, theme,
partial or template changes invalidate every dependent row; content changes
invalidate that route and dependent listings. An old revision cannot approve a new
one. Source availability failures remain `UNVERIFIED`, not silently excluded.

Visual signoff is against the chosen intent: source fidelity for preserve,
approved design/content for renew. It requires zero uncovered required surfaces
and zero unexplained regressions against that reference. `FAIL` or `UNVERIFIED` blocks that signoff, even when a separately scoped
technical publication has approval. An intentional deviation needs exact before/
after evidence, specific user benefit and accepted scope; “cleaner” is not a reason.

Preserve-mode examples from a moving-services migration:

| Surface | Passing evidence | Separate visual result |
| --- | --- | --- |
| Mobile menu | Keyboard focus and Escape work | FAIL: header moves, source service group is missing, open-menu composition differs |
| Category archive | Every destination URL exists | FAIL: source sequence, card anatomy and columns differ |
| Article body | All text imported | UNVERIFIED: unique embed and footer were never compared |

Do not report “all design checked” from a viewport or recipe sample. Keep source
link-order comparisons and paired contact sheets with the report. The same contract
applies to WordPress, URL, Astro and multisite migration; do not create separate,
weaker checklists for individual import mechanisms.


## Navigation and empty-media variants

Structured research imports must use explicit import authority, not ordinary
editor API writes. Core 0.2.95/MCP 0.45.74 support `create_page(write_mode:
"import")`, `read_page_authority` and atomic `import_page_fields`. Preserve
approved answers and owner-cleared nulls. Add historical anchors to existing
keyed items as individual leaves; never send replacement arrays to add one
field. Use the same selected Site/version and the current authority revision.
Stop on 409 rather than overriding or resetting provenance. See the Pages tools
guide for schema opt-in, version availability and path escaping.

Inventory first-step input banners independently of final submission providers.
Preserve their fields, required/minimum validation, service tabs and direct links,
mobile collapsed/open states and navigation even when the final integration is
deferred. Core 0.2.40 provides native `core/navigation_form` and mixed `core/tabs`.
Read their schema instead of rebuilding them in HTML or reintroducing a provider
block. Defaults are same-origin and tab-scoped; never place addresses in URLs or
claim cross-origin prefill. The receiving form must explicitly accept the fields.

Compare listing rows with both real and missing images. Use shared post-card
placeholder settings for theme decoration, preserving real featured images and
explicit `show_image: false`. Compare actual footer link height plus gap, wrapping,
focus and column breakpoints; compact navigation density is an intentional option.
Verify native preview and static output on the agreed viewport boundaries.

## Domain migration and redirect capacity

Use `guide_publishing_domain_change` when advertised by this installation. Read
its checklist, preview settings impact before replacing a candidate, preserve
verified content when only redirect hosts change, and obtain explicit approval
for the traffic summary and any interruption. A saved future hostname is not live.
Organization-admin `onboard_publishing_domain_zone` can create a pending zone and
review a DNS scan; copy records DNS only and verify the full inventory (especially
mail and DKIM) before the human registrar step. Never infer completeness from a scan.

Core 0.2.107 checks Pages capacity during dry-run and final upload:
2,000 static, 100 dynamic, 1,000 characters per line, with generated slash variants
and hostname aliases included. `_redirects` has a bounded 10 MiB transport envelope;
`_headers` keeps 128 KiB. Source preflight counts configured rules conservatively;
final output excludes redirects shadowing built pages. Remove obsolete shadowed
rules at source when close to capacity. Never split `_redirects` into multiple files.
After publication, run `verify_migration_urls` against the agreed full inventory.
Do not delete old provider redirect lists without separate explicit approval.

Record render/media reuse and actual preparation duration separately. A cache
format, renderer, indexing or content change may require one full baseline build;
a synthetic cache test does not prove a customer site's timing target. Media
transfer timeouts retry the same frozen job with checkpoints, not a new publication.

### Sharing metadata

Compare saved full source and deployed target HTML with
`python3 scripts/typeroll/compare_seo.py qa/source.html qa/target.html`.
The report includes document metadata, `og:image`, `og:title`,
`og:description` and Twitter tags, including missing and duplicate tags.
Record intentional differences; an image URL changed by migration needs review
against the media mapping, not automatic approval. This script does not fetch
pages or change content. Keep source snapshots free of private data.

From Core 0.2.120 / MCP 0.45.90, preserve distinct sharing text in Page
`og_title` and `og_description`. Empty fields use SEO metadata. The public
content-type field mapped to Schema.org `image` supplies the image after
`og_image`, before site defaults. Its `<field>_alt` supplies the image description
when public; `seo_image_alt` is the explicit override. Never copy a site logo
into every Page merely to reproduce an old fallback.
