---
name: tr-responsive
description: Use when a layout must behave differently at different screen sizes — different grid columns per breakpoint, an icon-box that's icon-on-top on mobile but icon-left on tablet, hiding a block on small screens, fluid type. Triggers on "responsive", "mobile/tablet/desktop layout", "stack on mobile", "X columns on desktop and Y on mobile", "olika på mobil/surfplatta", "responsivt".
---

# Make a Typeroll block layout responsive

Typeroll has a built-in five-breakpoint system. You almost never hand-write
media queries — you set per-breakpoint values on responsive fields and the
renderer compiles the `@media` rules per block instance.

## The five breakpoints (mobile-first)

`mobile (<640) · tablet (≥640) · laptop (≥1024) · desktop (≥1280) · wide (≥1536)`

A responsive field takes either a scalar (applies everywhere) or a sparse
object `{ mobile?, tablet?, laptop?, desktop?, wide? }`. Missing breakpoints
inherit from the next smaller one. So you only set the breakpoints that change.

## Setting per-breakpoint values

Use `set_block_responsive` (or pass the object form directly in `add_block` /
`update_block` data). `read_block_type <id>` tells you which fields are
`responsive`.

The breakpoint object belongs on the responsive field inside `block.data`,
for example `data.cols`. Do not add a top-level `block.responsive` object: it
is not a rendered field, and page, partial and Page-template writes
reject it instead of silently storing an inert value.

```
# 4 columns on desktop, 2 on tablet, 1 on mobile:
set_block_responsive target={kind:page,id:home} block_id=<grid-id>
  field=cols value={ mobile: 1, tablet: 2, desktop: 4 }

# icon-box: icon on top on phones, beside the text on tablet+:
set_block_responsive ... block_id=<iconbox-id>
  field=layout value={ mobile: "icon-top", tablet: "icon-left" }
```

Pass a scalar to collapse a field back to one value everywhere, except the
listing defaults below.

### Listing grids and content gutters (Core 0.2.13)

`core/repeater` and aliases such as `core/page_list` use one grid column below
768px even when scalar `cols` is larger. Set `mobile_cols: 2` only when multiple
mobile columns are intentional. An explicit responsive `cols.mobile` is honored;
`mobile_cols` takes precedence. Above this threshold `cols` works normally.
Masonry is opt-in and also uses the explicit mobile count. Other blocks retain
the five breakpoints above.

Content gutters default to 1.25rem below 768px and 1.75rem at/above 768px.
Full-bleed section backgrounds keep their padded inner content. Customize
`--content-gutter` in site CSS if needed. Rebuild published sites after upgrading
Core to apply these shared preview/static defaults.

### Worked example — the classic feature grid

"4 cards/row with icon-on-top on desktop, 2/row with icon-left on a landscape
iPad, 1/row icon-on-top on a phone":

1. `core/grid` containing `core/icon_box` cards (or a `core/repeater` with
   `item_block: core/icon_box` for a Page-driven list).
2. On the grid: `cols = { mobile: 1, tablet: 2, desktop: 4 }`.
3. On each icon_box (or the repeater's item defaults):
   `layout = { mobile: "icon-top", tablet: "icon-left", desktop: "icon-top" }`.

No media queries authored — the build emits per-instance `@media` blocks and
the editor preview honours them. Flip the device toggle in the editor header
(Mobil / Mobil-liggande / iPad / iPad-liggande / Desktop) to author and verify
each breakpoint.

## Hiding a block at some sizes

`Block.hidden_on: Breakpoint[]` is universal — no per-block opt-in. E.g.
`hidden_on: ["mobile"]` drops the block below 640px. Use it instead of building
a "mobile-only" duplicate.

## Authoring a CUSTOM block type that's responsive

Two halves, BOTH required (`create_block_type` / `update_block_type`):

1. Mark the field `responsive: true`.
2. Expose it on the **outermost** template element as a CSS variable:
   `style="--{field}:{{field}}"`, then read `var(--{field})` in the block CSS.

If the field's value is directly usable CSS (e.g. `direction: row|column` →
`flex-direction: var(--direction)`), you're done.

If it's a friendly **token** that maps to CSS (e.g. `layout: icon-left` →
`flex-direction: row`), add a `responsive_css` map on the field — otherwise the
per-breakpoint overrides silently do nothing (a `[style*="--field:token"]`
selector can't see a `@media` override):

```
{ name: "layout", type: "select", options: ["icon-top","icon-left"],
  default: "icon-top", responsive: true,
  responsive_css: { "icon-top": "--dir: column;", "icon-left": "--dir: row;" } }
```

Then the block CSS reads `flex-direction: var(--dir, column)`.

## Fluid type — usually automatic

`core/heading` and prose already use `clamp()` to scale smoothly between mobile
and desktop. `core/heading` separates semantic `level` (h1–h6, for SEO) from
visual `size` (sm–3xl/auto) — "h1 but only as big as an h3" is one field, no
breakpoints needed.

## Gotchas

- Setting a value only at `desktop` leaves smaller screens on the field
  *default*, not on your value — set `mobile` too if you want a non-default
  baseline (mobile-first).
- The editor preview width is approximate on a narrow panel, but the breakpoint
  you're editing is exact. Trust the deployed site / a wider window for `wide`.
- **Never paper over horizontal overflow with `html,body{overflow-x:hidden}`.**
  Setting `overflow-x:hidden` on `html` forces `overflow-y` to compute as `auto`
  (CSS spec), turning `<html>` into a fixed-height nested scroller — the page
  then won't scroll normally (`window.scrollY` sticks at 0) and renders blank
  below the fold. Instead, find the element that overflows (a fixed width, a
  `transform:rotate` card poking out, a decorative `::before`/`::after`, a grid
  that didn't collapse) and fix THAT element's width / clip it with
  `overflow:hidden` on its own section. Verify with
  `document.documentElement.scrollWidth === clientWidth` at 360–390px.
- `core/grid` `stack_at` and responsive `data.cols` both compile overrides
  that beat the inline mobile baseline. Verify the computed column count at
  the actual breakpoint; no page CSS workaround should be necessary.
- Background design reference: `docs/responsive-blocks.md` in the platform repo.


## Core 0.2.14 native defaults

Use section/hero as top-level background carriers; their inner content owns the
20px phone / 28px tablet gutters. Do not add another gutter to main. Section
padding auto is 48/64/80px at phone/768/1280; heading auto is H1 28/32/36 and
H2 22/24/24 at a 16px root. Use shared --type-h1…h4, --section-padding,
--block-gap, --card-padding and --grid-gap tokens for theme overrides.
Navigation collapses through 1023px and becomes inline at 1024px.
Images preserve the complete subject with intrinsic height and contain; request
cover and a ratio explicitly only when cropping is intended. Breadcrumb spacing
uses --breadcrumbs-before / --breadcrumbs-after. Custom field-list item_html
replaces native bullets; core/list marker none supports custom icons.
Preview and static CSS order is defaults → blocks/instances → site → Page;
specificity, inline CSS and !important still apply. Compare without temporary
corrective CSS before removing any existing site rules.


## Site-specific responsive widths (Core 0.2.28)

The five names stay the same, but their widths can be set in **Site settings →
Typography → Responsive block widths**, or through `update_site_settings`:

```json
{"responsive_breakpoints":{"tablet":576,"laptop":769,"desktop":1024,"wide":1280}}
```

Send all four increasing integer widths (320–2560px); `null` restores
640/1024/1280/1536px. Values are versioned with the site's settings. Responsive
block fields, repeater item overrides and `hidden_on` use these widths in the
editor preview and static output. Reload an open editor after changing them.
Republish to update live pages; changing widths invalidates rendered-page caches.

This does not change explicit menu `collapse_below`, grid `stack_at`, listing
mobile defaults or theme typography thresholds. Set the menu threshold separately
when it must match, and use explicit responsive `cols` for exact listing columns.
Check one pixel below and at each threshold, including fractional widths for
visibility. Do not hide layout overflow to make a test pass.

## Independent components (candidate capability 0.48.0)

Not available in Core 0.2.31. Read capabilities and the live block registry first.
Every core block accepts `data.responsive_breakpoints` with all four increasing
integers (320–2560); null restores Site widths. It affects only that block's
responsive fields/visibility, not children. Listing grid and item cards are
independent: put card widths in `item_overrides.responsive_breakpoints`.

A checklist card can use widths `{tablet:577,laptop:769,desktop:1041,wide:1440}`,
`layout:{mobile:"column",desktop:"row"}`, `image_width_percent:40`,
`image_sizing:{mobile:"fixed",desktop:"stretch"}`, `image_height_px:200`, and
explicit `image_fit:"cover"`. Intrinsic ignores pixel height; auto preserves it.
Use stretch only for row layouts. Border, x/y panel padding, background and
`title_font` are native fields. `action_label` no longer removes the title link;
`title_link:false` opts out. Secondary actions prevent whole-card overlays.

PDF styling is independent: `download_width:{mobile:"full",desktop:"fill"}`,
`download_size_px:13`, `download_weight:"700"`, `download_color`,
`download_border_width_px`, `download_radius_px`, `download_padding_x_px` and
`download_padding_y_px`. `actions_align:"center"` centers the action row.
`download_behavior:"download"` emits HTML download; cross-origin file hosts may
still cause browser navigation. Default is navigate, no proxy.

Columns expose `left_width_px:150` and `stack_below_px:481` (stack through480).
Set one fixed side; left wins if both set. Custom stacking overrides the preset.
Container `radius_px` and `shadow` (none/subtle/header) style a composed group.
Menus use matching SVG symbols; `close_size_px` overrides the close symbol size
without shrinking the44px hit area. Compare exact threshold boundaries in real
preview and static output before deleting corrective CSS.

## Native image framing and body heading scales (Core 0.2.35+)

Use `core/image.scale_percent` (100–200, responsive) for deliberate horizontal
framing; 100 retains the uncropped original. `focal_x`/`focal_y` are percentage
positions; Image `fit`/`aspect_ratio` and Post Card `image_fit`/`image_aspect` are
responsive. Keep intrinsic dimensions and original SVG/alt. A mobile 120% centered
image uses scale_percent={mobile:120,tablet:100}, focal_x=50 and local
responsive_breakpoints={tablet:577,laptop:769,desktop:1024,wide:1280}.

Set `h1_size_px`…`h6_size_px` on `template_content_slot`, not every Page heading.
These responsive values inherit through nested containers; explicit font_size_px
on a heading wins. `heading_before_px`/`heading_after_px` control article-rhythm
spacing. The slot's local breakpoint map controls its scale. Breadcrumbs flow as
inline ordered-list items, including long current titles. Do not shorten customer
headings to compensate for a layout issue. Read the deployed block schema first.

## Native text links (Core 0.2.36+)

Inline links in native rich-text surfaces (including lists, tables and image
captions) are underlined and keyboard-focusable by default. Use native fields;
do not add customer CSS patches just to restore recognizable text links. Card
titles, image wrappers, buttons and navigation retain their own styles. Republish
existing sites to adopt the updated renderer.
