# Settings that reach the page

Status: accepted (Core 0.2.75)

## The failure class

Migrating moveria.se to blocks found five settings that a site could store,
preview and publish without effect, none of them reported anywhere:

- A platform default no setting could reach: `reset.css` set
  `-webkit-font-smoothing: antialiased` on every site, so migrated text drew
  thinner on macOS than the original, and the only fix was site CSS.
- A replaced control: with `suggest_address`, the Places loader hid the block's
  input and showed Google's `PlaceAutocompleteElement`, which received none of
  the block's input settings. Two kinds of field sat side by side.
- A missing part: `navigation_form` had no button icon or weight, so the site
  needed CSS for a common button.
- A wrong value type: `active_font_weight: "600"` on `core/tabs` was stored and
  never rendered, because the renderer only emits a number field whose value is
  a number.
- A projection gap (found while fixing the first): the static publication
  projects `settings.fonts` field by field, so a new font setting would have
  been previewed and never published.

Each case passed its tests, because the tests checked strings (the loader
contains `placeholder`) or snapshots (output did not change), not that a
setting changes what a visitor sees.

## Rules

1. **A platform default that changes appearance is a setting.** Opinionated
   CSS in `reset.css`/`global.css` (font rendering, link decoration, colour
   scheme) belongs in a theme setting with the browser default unless there is
   a reason, gated on a render version when it changes existing pixels
   (`fontSmoothingCss`, render version 6).
2. **A capability that replaces a block's control inherits its presentation.**
   Blocks describe a field with the `--tr-field-*` custom properties
   (`min-height`, `padding-x`/`-y`, `border-width`/`-color`, `radius`,
   `background`, `color`, `icon-color`, `icon-size`, `font-family`) and the
   provider maps them onto its control through the provider's supported
   styling. Provider specifics stay in the loader; the block only declares the
   contract. A future provider, or a future block with address fields, uses the
   same properties.
3. **Parity is tested in a browser.** `address-field-parity.spec.ts` compares
   computed border, radius, height, background, colour, font and colour scheme
   of the replaced control with a plain field, at 390 and 1280 px, in light and
   dark browsers, in Chromium, Firefox and WebKit. It runs against a stand-in
   with Google's default styles and against the real element. The loader uses
   Google's `quarterly` channel so element changes arrive on a known schedule.
4. **Every field changes what renders.** `presentation-settings.test.ts` sets
   each schema field of each core block to a valid value and requires the
   markup or CSS to change. Fields that need runtime data are listed with where
   they are tested. Accepted-but-never-rendered fields are listed as known
   defects, and the test fails when one starts rendering so the list stays
   true. Separately, a `css_unit` field's `--<name>` must be read by some CSS.
5. **Value types are part of the contract.** The renderer converts numeric text
   for number fields (`coerceFieldValue`); write routes report anything else
   that will not render as `field_type_mismatch`, with its path.
6. **A new rendered setting is added to every projection.** The static
   publication (`scripts/lib/static-publication.mjs`), the v1 settings
   validation, the portal form, MCP descriptions and the docs move together.
   `static-publication.test.mjs` reads every `SiteSettings` field from the type
   and fails until each one is published or listed as unpublished with a reason.
7. **Base CSS holds no unreachable opinions.** A declaration on a bare element
   selector in `reset.css`/`global.css` must be a neutral reset, read a
   variable a setting or style sets, or be listed with how a site changes it.
8. **Migrations report gaps.** `tr-migration-evidence` tells agents to report a
   missing or ignored capability, in a fixed format, instead of patching it
   with site CSS.
9. **A key no field declares is not a setting.** `add_block`/`update_block`
   reject a `data` key that the block type (or the type it expands to) does
   not declare and the renderer does not read, with where it probably belongs
   (`item_overrides.<key>` on a repeater, else the closest field names); tree
   writes report it as `unknown_field`. The keys the renderer reads without a
   declaration are listed in `UNDECLARED_BLOCK_DATA_KEYS`, and
   `block-unknown-fields.test.ts` renders every core block to prove the check
   never rejects a key the renderer reads. `null` in `update_block` removes a
   key.

## Defects these guards found

The field test found eleven fields that were accepted and never rendered:
`core/video` `poster`, `autoplay`, `loop`, `muted`, `controls` and `lazy_load`
(the template was a bare iframe and the promised embed conversion did not
exist), `core/hero.video_url`, `core/testimonial.rating`,
`core/form.submit_label` and the repeater carousel's `autoplay`, `show_arrows`
and `show_dots`. Radio and checkbox groups enforced `required` only at
submission. All are fixed in Core 0.2.75: markup changes in render version 7,
the form label and group validation as bug fixes. `render_versions[].script`
lets a block's runtime arrive with the version that needs it.

## Not covered

- Google's element offers no supported placeholder selector
  (`::part(input)::placeholder` does not apply). The placeholder matches a plain
  field because both use the browser default once `color-scheme` follows the
  page; a placeholder colour setting would need Google support first.
- The Maps API inserts its font stylesheets with `document.head.insertBefore`
  and has no option to skip them. The loader drops those two exact URLs; if
  Google changes how it inserts them, the element still uses the block's font,
  and only the unused stylesheet request returns.
