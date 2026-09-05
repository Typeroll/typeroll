---
name: tr-new-site
description: Use when the user wants to create a new Typeroll site from scratch, set up the initial design, or bootstrap a blank site with working header/footer, brand colors, and a homepage. Also triggers on "start a new site", "set up a site for", or "build a website for [company]".
---

# Bootstrap a new Typeroll site

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


Start here when the site already exists as a database record (created via
the portal UI or API) but has no design, no header/footer, and no pages.
The goal is to go from blank to a working 4-page site with correct brand
identity in a single session.

**Pages are built in block mode** — the platform default. Blocks give
structured, per-field editing, native full-bleed sections, responsive
breakpoints, and templates. HTML mode is the secondary path for
hand-crafted one-offs and migrated content (section at the end).

## Preconditions

- `@typeroll/mcp-server` configured with a valid `TYPEROLL_API_KEY`.
- The site exists (confirm with `get_site`).
- You have the customer brief: company name, industry, 2–3 key brand colors,
  tone of voice, and a list of initial pages.

## Recipe

### 1. Audit current state

```
get_site
get_site_capabilities   # template_capabilities_version — what this deployment supports
read_site_settings      # see what (if anything) is already configured
list_pages              # don't overwrite pages that already exist
list_partials           # check if header/footer already have content
list_block_types        # the per-site block palette — NEVER assume, always list
```

**Do not choose a content mode or file a platform gap before these calls
return.** For every required visual/behavioral element, map it to an existing
block or composition first. If the summary suggests a match, use
`read_block_type` to inspect the exact schema. Only call something “missing”
after checking capabilities, the complete palette, and custom block types.

Common requirements that are easy to misclassify:

| Requirement | Existing Typeroll primitive |
|---|---|
| Full-bleed hero flush below the header | `core/section` + `core/hero`; block-mode sections already own the full width and have no page-shell padding |
| Responsive icon/card grid | `core/grid` + `core/icon_box`, or `core/feature_grid`; set responsive fields with `set_block_responsive` |
| Custom cards backed by a collection | `core/repeater` / `core/collection_list` with a site-authored `item_compatible` block type as `item_block` |
| Grouped collection listing | `core/repeater` with `group_by`; array-valued fields place an item in every matching group |
| Breadcrumbs in a page template | `template/page_breadcrumbs`; page and item routes supply a server-rendered trail |
| Generated heading index | `core/table_of_contents`; choose heading levels and set `source_field` for collection content |
| Previous/next collection item links | `template/item_navigation`; defaults to collection order and can bind explicit neighbor fields |
| Download CTA that disappears without a file | `template/show_if` around a context-bound `core/button`; a dedicated download block is only editor convenience |
| Sticky/custom header and multi-column footer | Block-mode header/footer partials plus layout blocks, or one reusable custom block type |
| Cookie notice | `settings.cookie_consent`, not a page block |
| Consent copy owned by an installed Extension | `list_extension_installations` → `read_extension_installation` → `update_extension_installation_config`, using exact manifest schema keys; the update queues a production deploy by default |
| One-off HTML + JavaScript embed | `core/embed`; reusable widgets use a custom block type with `script` |
| CTA/button variants | `core/cta` and `core/button`, styled from site tokens or a narrowly scoped class |
| Two-column image/text | `core/media_card`, `core/feature_row`, or `core/columns` |
| Figures, captions and tables | `core/prose` / richtext; the sanitizer preserves these semantic tags |
| Full-width block page without a content shell | Native block mode; top-level `core/section` is unconstrained |
| Brand colors and typography | Site `colors`/`fonts` tokens consumed by core blocks |

Real gaps should say what was checked and why the nearest primitive is not
enough. “I did not see a dedicated block name” is not evidence by itself.

### 2. Brand + settings

One `update_site_settings` call with every field you know:

```json
{
  "site_name": "Acme Studio",
  "tagline": "Short, punchy tagline",
  "language": "sv",
  "trailing_slash": "always",
  "colors": {
    "primary":    "#1a1a2e",
    "secondary":  "#16213e",
    "accent":     "#e94560",
    "background": "#f5f5f5",
    "surface":    "#ffffff",
    "text":       "#1a1a2e",
    "text_light": "#6b7280"
  },
  "fonts": { "heading": "Playfair Display", "body": "Inter", "size_base": 16 },
  "contact": { "email": "hej@acme.se", "phone": "+46 8 123 456" },
  "social": { "instagram": "https://instagram.com/acme" }
}
```

Read it back with `read_site_settings`. Google Fonts names are
case-sensitive display names ("Plus Jakarta Sans", not "plus jakarta").

**Site icons are part of brand setup** — upload favicon (32–64px), a
180×180 apple touch icon, and a 192×192 app icon; set `favicon`,
`apple_touch_icon`, and `icon_192`. No icon assets? Derive a proposal (see
`tr-brand`). Also set `settings.logo` to the uploaded brand mark — it feeds
OG/schema even if the header uses a different lockup.

Set `iframe_allowed_hosts` when customer content embeds a provider outside
the built-in YouTube/Vimeo/Google Maps/Calendly set. Values are exact domain
hostnames, never URLs or wildcards. Read the setting back before deciding that
an iframe cannot be represented.

### 3. Header + footer partials

**Start from the native preset — don't hand-roll navigation.** Read
`tr-header-footer` and use its `template/site_logo` + `core/navigation`
composition. The server-rendered landmark, current-page state, no-JS links,
mobile disclosure, focus treatment, and responsive behavior are Core
contracts rather than tenant CSS/JavaScript.

Stage the complete tree with `update_partial partial_id="header"
patch={blocks:[...]} save=true`, then call `set_partial_mode partial_id="header"
to="blocks"`. Repeat for the footer and read both partials back. The inactive
HTML representation is retained for rollback; changing `content_mode` through
ordinary PATCH/PUT is rejected intentionally.

Use HTML mode only when preserving legacy authored markup that cannot yet be
represented natively. Partials receive the same `{{site.*}}` render context as
page blocks. Keep the first section and header backgrounds intentional; do not
add a decorative border merely to compensate for mismatched spacing.

### 4. Homepage — block tree

`create_page` with the whole tree in one call. Omit block `id`s — the
platform assigns them (`blk_…`); you read them back for later
`update_block` calls.

```
create_page title="Start" slug="" status="draft" content_mode="blocks" blocks=[...]
```

A proven landing-page skeleton (every top-level block is a `core/section`
— sections are **natively full-bleed**: the background runs edge-to-edge,
content is constrained by the section's own inner container via the
`width` field. NEVER use 100vw negative-margin hacks. Anchor ids and
custom classes via `style_overrides` are safe on sections from
template_capabilities_version ≥ 0.15.3; on 0.14.x–0.15.2 they wrap the
section in a div and silently break full-bleed — there, put the anchor
on a block *inside* the section instead):

```json
[
  { "type": "core/section", "data": { "background": "#ffffff", "padding_y": "lg" }, "children": [
    { "type": "core/media_card", "data": {
        "image": "MEDIA_URL", "image_alt": "…", "image_side": "right",
        "heading": "Huvudrubriken", "heading_level": "h2",
        "text": "<p>Ingress …</p>",
        "button_label": "Kontakta oss", "button_url": "/#kontakt"
    } }
  ] },
  { "type": "core/section", "data": { "padding_y": "lg" }, "children": [
    { "type": "core/heading", "data": { "text": "Så funkar det", "level": "h2", "align": "center" } },
    { "type": "core/grid", "data": { "cols": { "mobile": 1, "tablet": 2, "desktop": 3 }, "gap": "lg" }, "children": [
      { "type": "core/step_card", "data": { "number": "1", "title": "…", "text": "<p>…</p>" } },
      { "type": "core/step_card", "data": { "number": "2", "title": "…", "text": "<p>…</p>" } },
      { "type": "core/step_card", "data": { "number": "3", "title": "…", "text": "<p>…</p>" } }
    ] }
  ] },
  { "type": "core/cta", "data": {
      "heading": "Redo att börja?",
      "primary_label": "Kontakta oss", "primary_url": "/kontakt"
  } }
]
```

Block-palette guidance (verify against `list_block_types` — the source of
truth):

- **Hero:** `core/media_card` inside a white section (image beside copy),
  or `core/hero` (eyebrow/heading/subheading + `primary_*`/`secondary_*`
  buttons — rendered server-side; `layout: split-right` puts the image
  beside the text). For a plain text hero: section + heading + prose +
  button.
- **Alternating image+text rows ("zig-zag" feature/step lists):**
  `core/feature_row` (template_capabilities_version ≥ 0.29.0) — balanced
  halves that hug the center gutter so wide screens never open dead air,
  natural-aspect image, `image_side: left|right` per row, mobile stack
  order as a field. Prefer it over hand-building `core/columns` with an
  unbalanced ratio + width-capped text (the classic dead-air trap). Use
  `core/media_card` instead when you want a *boxed card* with a
  filled/cropped image.
- **`core/heading`** decouples `level` (h1–h6, semantics) from `size`
  (visual) — exactly one `level: h1` per page.
- **Images:** `core/image` with an uploaded media URL. The build pipeline
  automatically emits responsive `<picture>` with AVIF/WebP variants
  (run `generate_image_variants` after upload) — the in-portal preview
  shows a plain `<img>`, the deployed site gets the upgrade. Use the
  `radius` field for rounded corners.
- **Repeaters/listings:** `core/collection_list`, `gallery`,
  `feature_grid` etc. — alias blocks over `core/repeater`. Use these for
  collection-driven content instead of hand-writing listing markup. The base
  repeater also supports `group_by`, group ordering/headings, multi-valued
  membership, filters, custom `item_block`, and `item_overrides`.
- **Long-form navigation:** `core/table_of_contents` builds an anchor list
  from page headings. Collection block templates use
  `template/item_navigation` for deterministic previous/next links.
- **Forms:** `create_form`, then place `core/form` with its `form_id`.
  HTML-mode pages use `<x-form id="…" />`; both paths render the same signed
  shell and runtime. See `tr-forms`.
- **`core/html`** is the escape hatch for the genuinely unique thing —
  not a default. If you reach for it more than once or twice per page,
  note why (that's block-library feedback).

Slot containers (`core/columns`, `core/tabs`): populate them either by
passing the whole tree inline (`block={ type: 'core/columns', slots:
[[…],[…]] }`) or incrementally with `add_block parent_id=<columns-id>
slot_index=0|1`. Requires template_capabilities_version ≥ 0.15.2 — on
older sites use `core/grid` (children flow into columns) instead.

Partial last rows (template_capabilities_version ≥ 0.16.5): when N equal
cards don't divide by the grid's column count (5 cards, 3 cols), set
`last_row: 'center'` on the `core/grid` — the orphan row auto-centers.
NEVER invent a "wide" variant of one peer card to fill the hole, and
don't hand-roll 6-column CSS tricks; both distort content to patch
layout. On older sites, pick a column count that divides N.

Icons (template_capabilities_version ≥ 0.16.0): `type: 'icon'` fields on
`core/icon`, `core/icon_box`, and `core/step_card` render inline SVG when
the value is a name from `get_site_capabilities → core_icon_names` (a
curated Lucide subset — `check`, `star`, `shield-check`, `mail`,
`arrow-right`, `truck`, `chart-line`, …). Any other value (emoji, plain
text) renders as text, so emoji stand-ins keep working. Icons inherit
size from font-size and color from `currentColor`/the block's color
field. On older sites icons don't render — use emoji or CSS markers.

Editor schemas (template_capabilities_version ≥ 0.39.0): labelled enum
options, newline-edited string lists, nested object/repeating-array fields,
and internal-page pickers for URL fields are first-class. Do not flatten an
Extension's `props_schema` merely to make it editable.

For an Extension placed in an HTML header or footer, require
`supports_extension_html_partial_directive: true`. The broader
`supports_extension_html_directive` flag covers HTML page bodies and is not
proof that an older static build expands partial directives.

For a cross-page Extension flow, require both
`supports_extension_site_navigation` and `supports_extension_storage`. Use
`context.site.navigate("/path/")` and installation-scoped
`context.storage.session` rather than direct root-path navigation, Web Storage,
or personal data in query parameters. This keeps navigation inside the current
preview and preserves state without exposing it through URLs or referrers.

Known limitations (honest list — don't fight them):

- **`core/tabs` label icons don't render** (the tab strip is built
  client-side without the icon pipeline). Text labels only.

Theming: block primitives render neutral. Brand color/typography comes
from settings (step 2). For page-specific polish (e.g. a colored card
treatment), a single `core/html` block with a small `<style>` scoped to
`[data-bid]`/section selectors is acceptable — keep it minimal and note
it in your log.

### 5. Inner pages

Same pattern: `create_page` with `content_mode: "blocks"` and a section
tree. Standard set: Om oss, Tjänster, Kontakt — or what the brief says.
Default new pages to `status: "draft"`; publish after review.

### 5b. If the legacy site is still live, scrape canonical content

For pages with canonical text (privacy policy, terms, about), `WebFetch`
the live page and carry the text verbatim — don't rewrite legal copy
from memory. Convert to prose blocks (or one `core/html` for complex
legacy markup).

### 6. Preview + iterate

```
get_preview_link                  # signed URL for browser review
get_page_preview page_id="home"   # rendered HTML for structural checks
```

**Self-review the visuals before you call it done — appearance AND
readability, not just structure.** Screenshot the deployed/preview site at
desktop (~1440px) and mobile (~390px) and look: logo FULLY VISIBLE (not clipped by
a header's overflow:hidden) + legible + brand-compliant against its actual
background — screenshot the header IN CONTEXT, not the logo element in isolation
(an element shot hides layout clipping); a light wordmark must not sit bare on a
light surface. Text contrast everywhere, no horizontal scroll or mid-word
breaks, every image rendered, mobile layout actually collapsed. "No overflow +
copy present" is not a design review — never report a build as done/perfect off
structural metrics alone.

Share the preview link. Iterate on feedback with `update_block` /
`add_block` / `move_block` — that's the point of block mode: surgical
edits, not full-page rewrites.

### 7. Deploy

When the user approves:
```
trigger_deploy
get_deploy_status job_id=<id>
```

## Secondary path: HTML mode

For migrated legacy pages or a hand-crafted one-off, `content_mode:
"html"` still works. Rules that apply there (and only there):

- Wrap the body in a page-scope `<article class="my-page">` and prefix
  selectors with it — the `.page-content` shell sets width/padding at
  normal specificity.
- HTML-mode bodies are container-constrained; full-bleed requires the
  negative-margin escape (`margin-left: calc(50% - 50vw); width: 100vw`)
  — never combine with `overflow-x: clip` on a wrapper.
- `set_page_mode` flips a page between modes;
  `convert_page_to_blocks` does a heuristic HTML→blocks conversion.

## Pitfalls

- **Don't create pages that already exist** — `list_pages` first; use
  `update_page` if the slug is taken.
- **`update_page` takes a `patch` object**, not flat fields.
- **Don't hardcode block field names from memory** — schemas are
  per-site (`list_block_types`/`read_block_type`).
- **One `level: h1` per page** (core/heading) — SEO + screen readers.
- **Don't simplify data during import** — preserve Swedish characters in
  labels (`affärsutveckling`, not the ASCII-folded slug), keep titles
  verbatim; slugs are derived for URLs only.
- **Minimal JS.** Inline `<script>` in page content is stripped by the
  sanitizer. One-off interactivity uses `core/embed`; reusable interactivity
  uses a block-type `script`; site-wide code belongs in `scripts_body_end`.
