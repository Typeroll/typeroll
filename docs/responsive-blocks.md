# Responsive blocks — how per-breakpoint behaviour works

This is the design reference for making blocks behave differently at different
screen sizes — not just "stack on mobile", but real per-breakpoint layout
changes like *4 cards per row with the icon on top on desktop, 2 per row with
the icon to the left on a landscape iPad, 1 per row with the icon on top on a
phone*.

It explains the model, the two authoring conventions, the editor surface, and
the one gotcha that used to make half the responsive fields silently do
nothing.

## The model in one paragraph

There are **five fixed breakpoints** (`packages/shared/src/breakpoints.ts`):
`mobile (<640) / tablet (≥640) / laptop (≥1024) / desktop (≥1280) / wide
(≥1536)`, mobile-first. A block field marked `responsive: true` accepts either
a scalar (applies everywhere) or a sparse object `{ mobile?, tablet?, laptop?,
desktop?, wide? }`. Missing breakpoints inherit from the next smaller one. The
renderer compiles the per-breakpoint deltas into a tiny per-instance
`<style data-bid="…">` block containing `@media` rules — so each block instance
carries exactly the overrides it needs and nothing else.

```ts
// data on a core/grid instance
{ cols: { mobile: 1, tablet: 2, desktop: 4 } }
```

renders (abridged):

```html
<div data-block="grid" data-bid="g7" style="--cols:1;…">…</div>
<style data-bid="g7">
  @media (min-width: 640px)  { [data-bid="g7"] { --cols: 2; } }
  @media (min-width: 1280px) { [data-bid="g7"] { --cols: 4; } }
</style>
```

## The convention that makes it work

A responsive field's value reaches the page as a **CSS custom property on the
outermost element**, named `--{field}`. The block's CSS reads `var(--{field})`.
The `@media` compiler overrides that same variable per breakpoint. That's the
whole contract:

```
template:  style="--cols:{{cols}}"
css:       grid-template-columns: repeat(var(--cols, 3), …);
```

Because the CSS reads the variable directly, the compiler's
`@media { --cols: 4 }` override "just works".

### The gotcha: token fields

Some fields don't store a directly-usable CSS value. `icon_box.layout` stores
`icon-top` / `icon-left` / `icon-right`, which must become
`flex-direction: column / row / row-reverse`. The old pattern mapped the token
with an **attribute-substring selector**:

```css
[data-block="icon_box"][style*="--layout:icon-left"] { --layout-dir: row; }
```

This is the trap: the selector matches the *inline style string*, which never
changes per breakpoint (it always holds the mobile value). So a
`@media { --layout: icon-left }` override changed the variable but nothing
re-derived `--layout-dir` — **responsive token fields silently did nothing**.
(The same bug hid in `grid`/`repeater` `cols`, which mapped `--cols` the same
way.)

There are two correct fixes, in preference order.

### Option A — expose a directly-usable value (preferred)

If the field's options can *be* the CSS value, make them so and read the
variable directly. `container.direction` already does this — its options are
`row` / `column`, and the CSS is `flex-direction: var(--direction)`. Nothing
else needed; responsive works for free.

`grid.cols` was fixed this way: the CSS now reads `repeat(var(--cols), …)`
directly instead of the `[style*="--cols:N"]` indirection.

### Option B — declare a `responsive_css` token map

When a friendly token (`icon-left`) must map to one or more real declarations,
declare the map on the field (`FieldDefinition.responsive_css`). The renderer
emits the **mapped declarations** per breakpoint instead of the useless raw
token:

```ts
{
  name: 'layout',
  type: 'select',
  options: ['icon-top', 'icon-left', 'icon-right'],
  default: 'icon-top',
  responsive: true,
  responsive_css: {
    'icon-top':   '--layout-dir: column;',
    'icon-left':  '--layout-dir: row;',
    'icon-right': '--layout-dir: row-reverse;',
  },
}
```

The block keeps its existing `[style*="--layout:…"]` rule for the **mobile
baseline** (and for non-responsive scalar values). The compiler emits only the
per-breakpoint deltas, on a doubled-specificity selector
(`[data-bid="x"][data-bid="x"]`) so the override beats the baseline rule:

```html
<style data-bid="ib3">
  @media (min-width: 640px) {
    [data-bid="ib3"][data-bid="ib3"] { --layout-dir: row; }
  }
</style>
```

**Security:** `responsive_css` lives in the block-type schema, which is
author-controlled for custom block types. The renderer runs every declaration
string through `sanitizeCssDeclarations()` — anything containing `{ } < > " @`
(rule / at-rule breakout characters) is dropped. So a malicious token map can't
escape its `@media` rule into arbitrary CSS.

## Editing it — the device toggle

The block/template editor's header has **five device presets** mapped 1:1 onto
the five breakpoints (Mobil / Mobil-liggande / iPad / iPad-liggande / Desktop).
Selecting one does two things:

1. Sets the **preview width** (scaled to fit the panel) so you see that
   breakpoint.
2. Sets the **active editing breakpoint**. Editing a `responsive: true` field
   then writes to *that* breakpoint, with an "inherited / own" badge and a
   reset-to-inherit control.

So the worked example at the top is authored as:

1. Drop a `core/grid` containing `core/icon_box` cards.
2. On the grid, set `cols`: Desktop → 4, iPad-liggande → 2, Mobil → 1.
3. On each icon_box (or the item template), set `layout`: Desktop → `icon-top`,
   iPad-liggande → `icon-left`, Mobil → `icon-top`.

No hand-written media queries; the renderer compiles per-instance `@media`
blocks and the live site + editor preview both honour them.

## Checklist for block authors

When adding a responsive field to a block type:

- [ ] Mark it `responsive: true`.
- [ ] Expose it as `--{field}` on the **outermost** template element
      (`style="--{field}:{{field}}"`).
- [ ] If the value is directly usable CSS → read `var(--{field})` and you're
      done (Option A).
- [ ] If it's a token that needs mapping → add `responsive_css` (Option B) and
      keep a baseline rule for the mobile/scalar case. Never rely on a
      `[style*]` selector alone for a responsive token — it can't see
      per-breakpoint overrides.
- [ ] `Block.hidden_on: Breakpoint[]` already handles "hide this at these
      sizes" universally — don't reinvent it per block.

See `packages/shared/src/render-blocks.ts` (`compileResponsiveData`,
`renderResponsiveStyleBlock`) for the implementation and
`packages/shared/src/__tests__/tier1-blocks.test.ts` for worked tests.
