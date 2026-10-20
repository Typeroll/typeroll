# Block parts

Status: accepted. Implementation: `packages/shared/src/block-parts.ts`.

## The failure class

An audit of core block CSS found hundreds of presentational declarations with
literal values (font size and weight, radius, gap, margin, padding, line
height, opacity, text decoration, shadow, colours) that no field, style or
variable reaches. `core/rich_heading` underlines its links with
`[data-block="rich_heading"] a { text-decoration: underline }`; moveria.se
needed category heading links without the underline and could only get them
with site CSS against platform markup. Core 0.2.80 added two fields for that
one case. Adding fields case by case does not end the class: every block has
such elements, and every site wants a different few of them changed.

## Design

A **part** is a named sub-element of a block type, declared once on the type:

```ts
parts: [
  { name: 'link', label: 'Links', selector: 'a', target: 'link' },
]
```

| Property | Meaning |
| --- | --- |
| `name` | Stable name, `a-z0-9_`, unique in the type. Never rename a released part: stored `part_styles` and styles refer to it. |
| `label` | Shown in the editor. |
| `selector` | The part's element(s), relative to the block root. Tags, classes, attributes, structural pseudo-classes (`:first-child`, `:nth-child()`), combinators, up to four comma-separated selectors. No state pseudo-classes or pseudo-elements: hover comes from the style. A leading `>` selects a child of the block root (`> .block-columns-col`); in a container block, anchor with it so the part never reaches a nested block. |
| `target` | The style kind that fits: `text`, `heading`, `list`, `button`, `container`, `link`, `image`. Pickers and checks list only styles with that target. |
| `style_field` | The block's own `style` field that already chooses this part's style per instance (`core/heading` `eyebrow_style_id`). `part_styles` does not take the part. |
| `color`, `background` | Colour tokens the block's CSS gives the part (a primary button: `on_primary` on `primary`), for contrast checks. Default: site text on site background. |
| `background_field` | A colour field of the block that holds the instance's background behind the part (`core/hero` `background`). |
| `decorative` | The part holds no text of its own (an overlay, a layout row); its style is not checked for text contrast. |
| `min_render_version` | The part's element exists from this render version. |

The style library reaches a part two ways:

- **Site-wide**: a style lists `parts: ["core/rich_heading.link"]` and applies
  to that part of every instance. A part takes one site-wide style.
- **Per instance**: block data `part_styles: { "link": "quiet-link" }`. Every
  type with a part that has no `style_field` gets a `part_styles` field
  automatically (`withPartStylesField`; core types in `CORE_BLOCK_TYPES`, site
  types in `validateBlockTypeDefinition`). `update_block` replaces the whole
  map, like other object fields; `null` removes it.

### CSS and precedence

Part rules are generated from the style with `styleRules()`, like class
styles (base, breakpoints upward, hover, scoped advanced CSS), on this
selector:

```css
/* site-wide */
:where([data-block="rich_heading"]:not([data-part-link]) a):not([class^="s-"],[class*=" s-"]):not(#\#):not(#\#)
/* an instance that chose quiet-link renders data-part-link="quiet-link" on its root */
:where([data-block="rich_heading"][data-part-link="quiet-link"] a):not([class^="s-"],[class*=" s-"]):not(#\#):not(#\#)
```

The specificity is always (2,1,0). Lowest first:

1. the block's own CSS, its field values and the shared text-link rules
   (attribute and class selectors);
2. default role styles (`.tr-role-eyebrow:not(#\#)`, (1,1,0));
3. the part style: the instance's choice, else the site-wide one. The scopes
   exclude each other, so exactly one applies and nothing of the other leaks;
4. a style class on the element itself (`s-<id>`: a heading's
   `eyebrow_style_id`, a button's `style_id`, a class from the rich-text
   editor), which the `:not([class…="s-"])` filter leaves alone.

Where two parts of a type overlap (`core/navigation_links` `link` and
`current_link`), the part declared later wins: rules are emitted in part
order, whatever the order of the styles in the library.

No `!important` is used. A part style also wins over the block's own fields
for the properties it sets, as a chosen `style_id` always has: to differ on
one instance, choose another style for the part there.

The CSS is emitted by `collectBlockAssets(…, { siteStyles })` with the block
CSS: the site-wide rules for the block types on the page, and one rule set per
distinct instance choice (repeater `item_overrides` and static `items`
included). The published build (`[...slug].astro`, `404.astro`), the portal
preview and the editor canvas (`render-preview.ts`) all pass the site's styles
and breakpoints, so they emit the same CSS. Without a part style the attribute
and the CSS are absent and output is byte-for-byte unchanged; the render
version references did not change.

### Checks

- `blockPartSelectorError` / `blockPartsProblems`: selector safety and part
  shape, for core types (a guard test) and site types (block type writes).
- `validateSiteStyle`: the `parts` reference format. `siteStyleLibraryErrors`:
  one site-wide style per part. `stylePartErrors` (styles store): the part
  exists on the site, with the closest names, and the style targets its kind.
- `unknownBlockDataFields`: a part name an instance cannot style is
  `unknown_field` at `data.part_styles.<part>`, with the closest part names or
  the part's own style field; `update_block`/`add_block` reject it.
  `blockFieldTypeWarnings`: a value that is not a style id is
  `field_type_mismatch`.
- `partStyleIssues`: the style exists and fits the part (`unknown_style`,
  `style_target_mismatch`, with the styles that fit), and its text is readable
  on the part's background (`part_style_contrast`: the instance's
  `background_field`, else the part's `background`, else the site's), with the
  APCA levels of the style library. Single-block writes refuse errors and
  return warnings; tree writes return both as warnings.
- Styles that list parts are measured on each part's surface
  (`stylePartSurfaces`) when they are saved.

## Guards

`packages/shared/src/__tests__/presentation-settings.test.ts`:

- **Every presentational value a core block writes is reachable.** Each
  literal presentational declaration in a core block's CSS at the latest
  render version must read a `var(…)`, or every element it styles in the
  block's sample markup must be one a style reaches (a declared part, or the
  `style_id` element) with a property a style sets, or root margins
  (`style_overrides.spacing_*`). The rest is listed in
  `__tests__/unreachable-presentation.ts`, grouped by block, each with a
  reason. A new unreachable declaration fails; so does a stale entry. Focus
  indicators are not counted: they stay the platform's.
- **Every declared part matches an element** of the block's sample markup at
  every render version where it exists.
- **Parts are valid** and the `part_styles` field is present exactly when an
  instance can style a part.

`presentation-audit.ts` holds the analysis and `PART_SAMPLES`, the data that
renders every part of a block.

## Declaring parts for a block

One block per change; each is mechanical.

1. **Find the declarations.** In `unreachable-presentation.ts`, the block's
   group lists what no style reaches. Group them by element.
2. **Declare a part per element a site would style.** Add `parts` to the block
   type literal (next to `schema`). Use the block's existing classes as
   selectors (`.block-cta-heading`), the most specific stable name, and the
   target of its kind. Prefer one part per visible element over a part per
   declaration. Name parts after what they are (`heading`, `primary_button`,
   `media`), never after a look.
   - If the block already has a `style` field for that element, set
     `style_field` instead of adding a second per-instance choice.
   - Give `color`/`background` when the block paints the part
     (a filled button) and `background_field` when a block field does.
   - Mark layout wrappers and overlays `decorative: true`.
   - In a container block, anchor selectors at the root with a leading `>`
     (`> .block-tabs-content > .block-tabs-strip …`), so they never reach a
     nested block, a nested block of the same type included.
3. **Render every part in the sample.** If the default sample leaves a part
   empty, add the block to `PART_SAMPLES` in `presentation-audit.ts`.
4. **Run the guards**: `npx vitest run src/__tests__/presentation-settings.test.ts`
   in `packages/shared`. Delete the entries that became reachable (the test
   names them as stale). What remains needs a reason a site does not need to
   change it (an accessibility control, a value a field already sets on
   the element), or another part.
5. **Check nothing else changed**: `npx vitest run` in `packages/shared`. The
   render version references must pass unchanged: declaring parts never
   changes markup or block CSS. Parts never need a render version, except
   `min_render_version` for an element older versions do not render.
6. **Document**: the parts are listed by `read_block_type` automatically. If
   the block has a page in `packages/docs-site/src/content/docs/` that lists
   its fields, list its parts there too.

Do not change a block's CSS to make a declaration reachable, unless the
change is a reachable variable with the old value as its fallback: output must
stay identical.

## Not covered

- Composed block types: their inner blocks have their own parts; the composed
  wrapper takes none yet.
- Root parts (`:scope`): a block root is styled through `style_id` where the
  block has one, and its margins through `style_overrides`.
- A part style can set only style properties (`StyleProps`). Declarations of
  other properties (`display`, `grid-template-columns`, `object-fit`) are
  layout, set by fields.
