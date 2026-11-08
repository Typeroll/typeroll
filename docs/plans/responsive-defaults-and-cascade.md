# Responsive defaults and a cascade sites can override

Status: proposed (2026-11-06). Delivered as render version 14 in phases; each
phase ships on its own and leaves sites on older versions unchanged.

## Problem

On typeroll.com the call-to-action buttons of the last section touch a
decorative band on every page at phone width. The site's theme draws the band
over the section's bottom padding and sets that padding to 150 px with
`!important`. A later rule in the same theme, `.tr-section{padding-block:3rem
!important}`, has the same specificity and wins, so the padding shrinks to
48 px under a 70 px band. Nothing in Core noticed.

The theme is 39 KB with 325 `!important` declarations, mostly for `gap` (46),
`font-size` (35), `margin` (25), `display` (22), `aspect-ratio` (20) and
`padding` (19). The site needs them for these reasons:

- **Specificity.** Block CSS uses selectors such as `[data-block="section"][data-pad="none"]`
  (0,2,0) and `[data-block="container"][style*="--gap:sm"]`. A site class
  (0,1,0) loses to them, and so does a site style unless it carries the
  `:not(#\#)` id-level boost.
- **Order.** `reset.css`, `global.css` and the header and footer styles are hoisted Astro
  CSS. They are emitted after site and page CSS, so a plain `a{…}` or
  `h2{…}` in the reset beats the site's own element rules on source order.
- **Responsive overrides.** Per-instance responsive fields compile to
  `@media` rules with `!important` (`render-blocks.ts`). A site value can only
  answer with another `!important`.
- **Missing defaults.**
  - Nothing reserves space before the footer: the gap is whatever the last
    section and the footer section happen to pad.
  - Decorations have no native form, so sites draw them with absolutely
    positioned pseudo-elements over content.
  - Breakpoints are hard-coded per block (540, 580, 720, 767, 900, 1000 and
    1023 px) and do not follow `responsive_breakpoints`.
  - No block uses container queries, so a grid inside a narrow column
    behaves as if it had the viewport.
- **No check.** Existing Playwright layout specs test bounds and horizontal
  overflow for a few blocks, with the CSS concatenated in a different order
  from a published page. No test renders every block type and template at
  several widths. No test looks for overlap, clipped text, small touch
  targets or the space before the footer.

## Principles

- Every block type, page template, header and footer looks right at every
  width from 320 px to 1920 px with no site CSS and no per-block adjustment.
- A site changes appearance with design values, styles and block fields
  first. Site CSS is a simple override: a plain class or element rule wins
  over platform defaults without `!important` and without knowing platform
  markup.
- The platform owns vertical rhythm. Unless a site explicitly chooses
  otherwise, there is space between blocks and before the footer.
- Decorations never cover content. A decoration that needs room reserves it.
- Each rule is checked automatically at several widths, as part of Core's
  tests and the release qualification, never as recurring monitoring of
  customer sites.

## Design

### 1. Cascade layers

From render version 14 every platform stylesheet is emitted inside named
layers, declared first in `<head>`:

```css
@layer typeroll.reset, typeroll.base, typeroll.tokens, typeroll.platform,
       typeroll.instance;
```

| Layer | Contents |
| --- | --- |
| `typeroll.reset` | `reset.css` |
| `typeroll.base` | `global.css` elements and utilities; from version 16 also the default header, footer and 404 styles and the cookie banner |
| `typeroll.tokens` | theme values, design scales and the spacing scale |
| `typeroll.platform` | the content well, `BLOCKS_RUNTIME_CSS`, each block type's styles (core and custom), block defaults, the site's named styles and element roles, and from version 16 the right-to-left mirror |
| `typeroll.instance` | per-instance field values and responsive overrides; from version 16 also authored spacing, image widths, column stacking widths, navigation form layout and custom-breakpoint visibility |

**As built.** Block CSS and named styles share one layer (`typeroll.platform`,
`LAYER_OF` in `cascade-layers.ts`) in the order and with the specificity they
had before layers, so their relationship did not change when layers arrived.
Named styles therefore keep their `:not(#\#)` specificity boost to beat block
defaults inside that layer. This only matters between platform rules: site
CSS is unlayered and beats both without a boost.

Site CSS and page CSS stay unlayered. Unlayered normal declarations beat
every layer, so a site rule wins regardless of specificity or position.
Inside the platform, the layer order replaces today's tricks:

- Instance values beat styles by layer. From render version 16 the mobile
  baseline of a responsive value is set from the instance layer instead of
  the inline style, so the breakpoint overrides lose their `!important`.
- From version 16 nothing but custom properties is written inline, block
  settings reach CSS as data attributes (`[data-gap="sm"]` instead of
  `[style*="--gap:sm"]`), and platform media queries map their literal widths
  to the site's `responsive_breakpoints` (render-v16.ts).
- Hoisted reset and global CSS can no longer win by appearing last.

The few platform rules that must hold over site CSS keep `!important`:
`hidden_on` visibility and the screen-reader utility. Inside a layer,
`!important` beats unlayered `!important`, which is the intended direction
for visibility.

Selectors inside the layers use `:where()` for structural parts, so a block
author's override within `typeroll.blocks` needs no specificity either.

**Gating.** `reset.css` and `global.css` are static files. BaseLayout and
`render-preview.ts` inline either the unlayered files (versions 1–13) or the
layered build of the same rules (14 and later). The reference snapshots record
both. Custom block types at version 14 have their scoped CSS placed in
`typeroll.blocks`. Their author-facing contract is unchanged; overriding them
from site CSS becomes easier.

### 2. Vertical rhythm and the space before the footer

- `main.page-content--blocks` ends with `--page-end-space`. It defaults to the
  section padding token and is fluid like it.
- When the last block is a section with its own background, its bottom
  padding is the space, and `--page-end-space` is 0. This keeps a coloured
  last section flush with the footer, as designed, without the platform
  adding a strip of page background.
- A page or template can set `page_end_space` to `none`. This is the
  explicit choice the default respects.
- The footer partial's opening section keeps its own top padding. Main and
  footer spacing are tokens a site can change in one place.
- Between blocks, `--block-gap` stays the single source. Sections and
  full-bleed blocks keep their own padding instead of margins, so adjacent
  backgrounds meet without gaps.

### 3. Native decorations that reserve space

Sections and heroes gain a `decoration` group (top and bottom):

- an image or SVG from the media library, or a built-in shape divider;
- a height token per breakpoint;
- fit and position.

A decoration is rendered in flow, as a sibling of the section's inner content.
Its height is added to the section's padding, so content can never sit under
it. The existing `divider_top`/`divider_bottom` shapes become presets of the
same mechanism. Their current overlap (`translateY(100%)` into the next
section) is kept for shapes only, where it is intended.

Site CSS lint warns about an absolutely positioned `::before`/`::after` with a
background on a section, and points to the decoration fields.

### 4. One breakpoint system, container-aware blocks

- Every block `@media` uses the site's `responsive_breakpoints` (mobile,
  640, 1024, 1280 and 1536 by default), emitted from the shared breakpoint
  helper instead of literals. The 540–1023 px literals map to their nearest
  named breakpoint, gated at version 14.
- Layout blocks that can sit in a narrow column use container queries:
  grid, columns, feature grid, card grids, pricing and team grids,
  media card, feature row and hero. Sections, containers and grid cells
  declare `container-type: inline-size`. A grid inside a 360 px column
  stacks as it would on a 360 px phone.
- Defaults at narrow widths:
  - multi-column content stacks;
  - button groups wrap and keep a gap;
  - media keeps its aspect ratio;
  - tables scroll inside their block;
  - long words break;
  - touch targets are at least 24 × 24 px (WCAG 2.2 AA);
  - side gutters never drop below `--content-gutter`.

### 4b. Shared content widths

- Version 14 defines `--content-narrow` (42rem), `--content-normal` (65rem)
  and `--content-wide` (80rem). Sections, containers, heroes, feature rows
  and calls to action take their content width from them; heroes and calls
  to action get a `width` field (narrow, normal, wide) like the others.
- A block placed directly in the page is its content width plus the page
  gutter on each side, so its content starts where a section of the same
  width starts. (Before, the content well held every such block at
  `--container-medium`, 1080px, whatever its `width`.)
- A wide feature row lets its default image and its text fill their
  columns; a feature row without its own background in a section starts at
  the section's content edge.
- The layout contract checks it: at 1024px and wider, top-level blocks of
  the same width start their content at the same left edge.
- Page template content slots keep their reading widths (560, 720 and
  1120px); those are a text measure, not a page edge.

### 5. Automated layout contract

A new Playwright suite, `tests/e2e/layout-contract.spec.ts`, renders the
following with the production cascade, at widths 320, 375, 768, 1024, 1280
and 1920, in light and dark:

- every core block type with its sample data, alone and inside a narrow column;
- every page template starter, with header and footer;
- the native header and footer partials;
- a long-content stress page (long words, many buttons, empty and very
  long fields).

Rendering uses one shared helper that emits the exact head order of
BaseLayout, so tests and publications share the cascade. The suite asserts:

- no horizontal scroll and no element wider than the viewport;
- no overlap between leaf content boxes (text, buttons, links, form
  controls, images, video) of different blocks;
- no overlap between leaf content and a decoration or any absolutely
  positioned box, including `::before`/`::after`;
- no clipped text (a box with hidden overflow whose content is larger);
- touch targets of at least 24 × 24 px;
- a positive space between the last content box and the footer, unless the
  page sets `page_end_space: none` or ends with a coloured section;
- buttons in a group keep a gap and wrap rather than overflow;
- a block stays inside the block that contains it (a grid cell, a column, a card);
- text is readable on the background it is drawn on;
- at phone widths (up to 480 px): headings are not so large that they break
  into lines of a few words (H1 at least 14, H2 16 and H3 18 characters per
  line), sections have at most 56 px vertical padding, and content inside a
  section is never more than 48 px apart;
- a heading in running text (H2–H4, inside a Text block or as a Heading block
  between Text blocks) has at least 2.5 times as much space above as below,
  so it reads as the start of what follows. Today a Heading block between
  Text blocks gets about as much space below as above (24/24 px on a phone,
  48/48 px on a desktop), and a heading inside a Text block exactly twice
  as much.

Phones get balanced, compact defaults: fluid type and spacing scale down
further below 480 px than they do today, so a page reads as a page, not as a
stack of oversized headings and empty bands.

Each failure names the block type, template, width and the two boxes. The
same checks run on the staging artifact qualification's published pages.
They are also available to agents as `check_layout` (MCP), which runs in the
agent's browser on a preview link. The server never crawls customer sites
for it.

### 6. Site CSS lint

`lintSiteCss` gains these checks:

- `!important` at version 14 or later, with the layer explanation and the
  plain override that replaces it;
- conflicting `!important` rules with equal specificity on the same
  property and selector set;
- absolutely positioned pseudo-element decorations on sections, as
  described in section 3.

They are warnings, never errors. Existing sites keep publishing.

## Migration

- Version 14 is opt-in, with the existing preview link and the
  `tr-upgrade-rendering` comparison skill. New sites start on it.
- Upgrading never rewrites site CSS. The lint lists `!important` rules that
  can now go. The comparison shows any visual change before the switch.
- typeroll.com moves to version 14 through MCP like any customer:
  - replace its decorative band with a section decoration;
  - remove the overrides the defaults now cover;
  - report anything it still needs as a platform finding.

## Phases

1. Layout contract suite and shared production-order render helper. Record
   today's failures per block type, template and width at version 13 (this
   is the backlog).
2. Cascade layers at version 14, with reference snapshots for both paths.
3. Page end space and native decorations.
4. Breakpoint unification and container queries per block, driven by the
   phase 1 failures until the suite passes at version 14.
5. Site CSS lint additions, the `check_layout` MCP tool and staging
   qualification.
6. typeroll.com migration.
