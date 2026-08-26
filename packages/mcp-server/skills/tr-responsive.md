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

```
# 4 columns on desktop, 2 on tablet, 1 on mobile:
set_block_responsive target={kind:page,id:home} block_id=<grid-id>
  field=cols value={ mobile: 1, tablet: 2, desktop: 4 }

# icon-box: icon on top on phones, beside the text on tablet+:
set_block_responsive ... block_id=<iconbox-id>
  field=layout value={ mobile: "icon-top", tablet: "icon-left" }
```

Pass a scalar to collapse a field back to one value everywhere.

### Worked example — the classic feature grid

"4 cards/row with icon-on-top on desktop, 2/row with icon-left on a landscape
iPad, 1/row icon-on-top on a phone":

1. `core/grid` containing `core/icon_box` cards (or a `core/repeater` with
   `item_block: core/icon_box` for a collection-driven list).
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
- **`core/grid` `stack_at` may not collapse on mobile** (a known platform bug):
  the block writes `style="--cols:N"` inline, and an inline custom property beats
  the media query that tries to set `--cols:1`, so the grid stays N-up and text
  wraps a letter per line. Workaround until fixed: in page-scoped CSS override the
  real property, e.g. `@media(max-width:640px){.my-section [data-block="grid"]{grid-template-columns:1fr!important}}`.
- Background design reference: `docs/responsive-blocks.md` in the platform repo.
