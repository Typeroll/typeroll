---
name: tr-page-template
description: Use when several pages on a Typeroll site share the same outer structure — category pages, service-detail pages, landing-page variants — and the user wants to edit the shared bits in one place. Covers two flows: the HTML-mode pattern with partials + `<x-include>` (works everywhere, recommended for Phase 1), and the formal block-mode PageTemplate (when the site is in block mode).
---

# Share structure across pages

When you have N pages that follow the same skeleton — say 7 category landing pages, each with `Hero → Intro → Features grid → CTA banner` — you don't want to edit 7 HTML bodies whenever the design changes. There are two ways to share structure in Typeroll, and the right pick depends on the site's content mode.

## Decide which pattern fits

| Site is mostly in… | Use |
|---|---|
| **HTML mode** (the Phase 1 default — most sites) | Partials + `<x-include>` — pattern A below |
| **Block mode** (`supports_blocks_mode=true` and the page's `content_mode='blocks'`) | PageTemplate via `set_page_template` — pattern B below |

You can check the site's mode by reading any existing page — `content_mode` is a top-level field on the page doc.

If unsure, default to **pattern A**. It works on every Typeroll site and the migration to block-mode templates later is mechanical.

## Pattern A — Partials + `<x-include>` (HTML mode)

A partial is a named HTML fragment. Putting `<x-include name="my-partial" />` anywhere in a page body inlines that fragment at build time. Editing the partial updates every page that references it on the next deploy.

### Recipe for "7 category pages with shared structure"

#### 1. Identify the shared chunks

Walk through one category page and mark which sections are the same across all 7:

```
[Hero: title + tagline + image]            ← varies per category
[Intro paragraph]                          ← varies per category
[Common: "Why choose us" three-tile band]  ← identical across 7
[Common: CTA banner with newsletter form]  ← identical across 7
[Common: footer testimonials]              ← identical across 7
```

Three reusable bits: `why-choose-us`, `cta-newsletter`, `footer-testimonials`.

#### 2. Create the partials

```
create_partial partial_id="why-choose-us" html_content="<section class=\"why\">
  <div class=\"container\">
    <h2>Varför oss</h2>
    <div class=\"why__grid\">
      <div class=\"why__tile\"><h3>Erfarenhet</h3><p>20 år i branschen.</p></div>
      <div class=\"why__tile\"><h3>Kvalitet</h3><p>Vi mäter på allt.</p></div>
      <div class=\"why__tile\"><h3>Närhet</h3><p>Lokala kontor i tre städer.</p></div>
    </div>
  </div>
</section>
<style>
.why{padding:4rem 0;background:var(--color-surface)}
.why__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:2rem;margin-top:2rem}
.why__tile h3{font-family:var(--font-heading);margin-bottom:0.5rem}
</style>"
```

Same for `cta-newsletter` and `footer-testimonials`.

The partial-id is what `<x-include>` references — keep it kebab-case and descriptive.

#### 3. Build each category page using the partials

```
create_page title="Tjänster för bostadsrätter" slug="brf" content_mode="html"
  html_content="<section class=\"hero hero--brf\">
  <div class=\"container\">
    <h1>Tjänster för bostadsrättsföreningar</h1>
    <p class=\"hero__tagline\">Trygg förvaltning, helt utan överraskningar.</p>
  </div>
</section>

<section class=\"intro\">
  <div class=\"container\">
    <p>Vi har förvaltat över 200 BRF:er i Stockholmsområdet sedan 2005.</p>
  </div>
</section>

<x-include name=\"why-choose-us\" />
<x-include name=\"cta-newsletter\" />
<x-include name=\"footer-testimonials\" />"
```

Repeat for the other 6 categories, varying only the `hero` + `intro` sections.

#### 4. Edit once, propagate everywhere

Adding a fourth "Why us" tile? Edit `why-choose-us` once:

```
replace_partial partial_id="why-choose-us" html_content="<section class=\"why\">
  ...four tiles instead of three...
</section>"
```

All 7 pages pick up the change on the next deploy. No multi-page diff.

### Edge cases

- **`<x-include>` self-closes or has an explicit close.** Both forms work: `<x-include name="x" />` and `<x-include name="x"></x-include>`.
- **Nested includes are NOT supported.** If `partial-a` references `<x-include name="partial-b" />`, the inner reference is not expanded. Flatten the hierarchy at design time.
- **Unknown partial → silently empty.** A typo in the `name` attribute removes the tag at expand time with no warning. Verify the partial id matches one returned by `list_partials`.
- **Partial content is sanitised on save.** `<script>` tags get stripped at partial creation, then the inlined HTML is sanitised again when the page renders. Two passes; both intentional.

## Pattern B — Formal PageTemplate (block mode)

Available when the site is in block mode (`supports_blocks_mode=true` and the page's `content_mode='blocks'`). A PageTemplate is a `Block[]` tree with one or more `template_content_slot` blocks marking where the page's own blocks go.

### Recipe

#### 1. List existing templates

```
list_page_templates
```

Returns templates already defined on the site.

#### 2. Create / pick a template

Templates live as `Block[]` trees under `paths.pageTemplate(orgId, siteId, templateId)`. They're created via the portal UI for now (no dedicated MCP `create_page_template` tool yet — the chat-tool surface in `anthropic.ts` exposes list + set, not create).

If the template you want doesn't exist, ask the user to create it via **/app/sites/{id}/templates** in the portal, or use the block-mode-aware AI chat in the portal which knows how to write template trees.

#### 3. Assign it to a page

```
set_page_template page_id="brf" template_id="category-landing"
```

The renderer composes the template's blocks with the page's blocks at build time via `composePageWithTemplate` (replacing each `template_content_slot` with the page's own block tree). The page's CSS / theme / SEO settings are unchanged.

#### 4. Editing the template propagates to every page

The same template id can be set on multiple pages. Editing the template updates them all on next deploy.

### When B beats A

- Block-mode editor surfaces template assignment as a dropdown in the page settings.
- Templates compose with the block tree, so the page author can drop content blocks into named slots rather than writing HTML.
- The renderer is aware of block CSS / JS bundling — assets per block type are aggregated automatically.

### When A still beats B even in block mode

- Need a small reusable HTML chunk in the middle of a block-mode page → still use `<x-include>` (block-mode bodies can contain free HTML blocks that include partials).
- One-page change wanted without affecting siblings → just edit the page's blocks; templates are all-or-nothing.

## Refactor: 7 already-existing pages into a shared partial

If the 7 pages already exist as separate HTML bodies with duplicated chunks:

1. `read_page page_id=<one of them>` and identify the shared HTML literally — character-for-character chunks that repeat across all 7.
2. `create_partial partial_id=<descriptive-name> html_content="<the shared chunk>"`.
3. For each of the 7 pages, `update_page` with the shared chunk replaced by `<x-include name="<name>" />`.
4. Deploy. The rendered output should be byte-identical to before; only the source pages got shorter.

Don't try to abstract first time and hand-write the partials. Refactor from real, working duplication.

## Pitfalls

- **Don't put hero / page-specific content into a shared partial.** A partial is for things that are *truly identical* across uses. The moment you want it to vary by page, lift the differing parts back into the page body.
- **Header and footer already use partials.** Don't recreate them inside a category-page shared partial — they're injected by the layout, not by the page body.
- **CSS scoping.** Partials carrying `<style>` blocks merge into every page that includes them. If two partials define `.tile` differently, the last one wins. Either namespace classes per partial (`.why__tile`, `.feature__tile`) or move shared styles into the site's global CSS via `update_site_settings` → `custom_css`.
- **Don't migrate to block-mode templates just because you can.** Phase 1 sites are HTML-mode by design; partials + includes give you 90% of the value with zero risk.
- **`<x-include>` in a partial body referencing another partial.** Won't expand (see edge cases). If you find yourself wanting this, you're building a layout system inside the partial system — at that point the site probably wants block mode.
