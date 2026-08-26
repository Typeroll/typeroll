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

### 2. Brand + settings

One `update_site_settings` call with every field you know:

```json
{
  "site_name": "Acme Studio",
  "tagline": "Short, punchy tagline",
  "language": "sv",
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

**Site icons are part of brand setup** — upload favicon (32–64px) and a
180×180 apple touch icon, set `favicon` + `apple_touch_icon`. No icon
assets? Derive a proposal (see `tr-brand`). Also set `settings.logo` to
the uploaded brand mark — it feeds OG/schema even if the header uses a
different lockup.

### 3. Header + footer partials

**Start from a vetted preset — don't hand-roll the layout.** `read_skill
tr-header-footer` has robust header + footer presets (centered logo, logo+nav
with a no-JS mobile menu, centered + 3-column footers) that avoid the usual
traps: clipped logos (no `overflow:hidden` near the logo), distorted logos
(`height` + `width:auto`), and broken mobile menus. Fill the placeholders and
restyle to the palette.

Partials are usually simplest in HTML mode (one nav, a few links — no
per-field editing needed). Keep them lean; literal site name (no template
engine in partials):

```html
<header class="site-header">
  <div class="header-inner">
    <a class="header-logo" href="/"><img src="LOGO_MEDIA_URL" alt="Acme Studio" height="40" /></a>
    <nav class="header-nav">
      <a href="/om-oss">Om oss</a>
      <a href="/kontakt">Kontakt</a>
    </nav>
  </div>
</header>
<style>
.site-header{background:var(--color-background);padding:1rem 2rem}
.header-inner{max-width:1080px;margin:0 auto;display:flex;align-items:center;justify-content:space-between}
.header-nav{display:flex;gap:2rem}
.header-nav a{color:var(--color-text);text-decoration:none}
</style>
```

`replace_partial partial_id="header" html_content="..."` — same pattern
for the footer. Design notes: **no border-bottom on the header if the
first page section should meet it seamlessly** — let background color
changes do the separating. Anchor links in nav (`/#section`) are fine.

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
    { "type": "core/grid", "data": { "cols": 3, "gap": "lg" }, "children": [
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
  collection-driven content instead of hand-writing listing markup.
- **Forms:** `create_form`, then a `core/html` block carrying the plain
  `<form method="POST" action={submit_url}>` embed with the hidden
  `_token` — see `tr-forms`.
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
  sanitizer. Interactivity ships via block-type `script` (requires the
  site's AI-scripts opt-in) or the human-managed `scripts_body_end`.
