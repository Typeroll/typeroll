# Layout defaults and owner decisions

Use current native composition starters and block schemas. These defaults are
starting points, not permission to overwrite an approved design.

- Keep incomplete grid rows left-aligned (`last_row: start`). Never enlarge one
  peer card just to fill the gap. Center only on an explicit owner request.
- Prefer `core/navigation_menu` with `core/navigation_links` desktop/mobile slots
  for a header drawer (below 1024 px). Read tr-header-footer; test 1023/1024 px.
- Separate dense footer about text from the link grid. Give it a readable width
  and a larger gap; inspect 390/1024/1280/1536 px. Equal columns need equal density.
- Sections own gutters. Do not erase side padding with `padding: 3rem 0` when
  only vertical spacing is intended. Wrap column-slot contents in a flow
  container with article rhythm when they need vertical block spacing.
- A narrow/normal/wide container inside an always-column container fills the
  column only from render version 12; below it, it shrinks to its content
  (width `wide` does not help). Raise render_version with tr-upgrade-rendering
  instead of working around it in content.
- Give cards one clear destination. Use whole_card_link without action_label
  or download actions. Check excerpt, image, whitespace and keyboard activation.
- Do not fade body text with opacity. Verify actual text/background contrast,
  current links on light/dark navigation, and all states.
- Preserve image subjects across widths. Choose contain/original sizing when
  cropping or upscaling is not intended. Hero crop, text placement, plates,
  corner treatment and category-page composition are project decisions in
  brief/brand.md, not a universal design.
- After migration, check heading hierarchy, unchanged preserved text, HTML
  comments, links with ../, and the home SEO title/suffix. Shared headings and
  titles must not be duplicated in body content.

Record deliberate departures in decisions.md with scope and owner approval.
Use a QA round per review: method, pages/viewports, expected differences, results,
unverified items and remaining defects. Record platform findings in
qa/typeroll-platform-feedback.md; do not bury them in workaround CSS.

## Site tokens before block overrides

Core 0.2.106 / template capabilities 0.54.0 adds palette names in all colour
fields and named typography/spacing steps. Check the connected capability
version; on older renderers use `var(--color-surface)` rather than a bare name.

Set colours and font families in site settings, then use named styles and
palette names in blocks. Do not write hex, rgb or font-family literals in block
content. Prefer `primary`, `secondary`, `accent`, `background`, `surface`, `text`,
`text_light`, and `on_primary`/`on_secondary`/`on_accent` for text on brand colours.
Use `surface_hover` for a darker interactive surface (derived automatically
unless explicitly configured). Existing semantic roles should be reused; a
new visual shade is not automatically a new semantic role. For a derived shade
use `color-mix(in srgb, var(--color-surface) 92%, var(--color-primary))`.
For an additional role not in the native palette, define a named site style
or a site CSS variable derived from existing palette variables, and document it.

Choose `heading`, `body` or `mono` for fonts. Font families belong only in the
site's `fonts` settings. Use type-size steps `xs`, `sm`, `md`, `lg`, `xl`, `2xl`,
`3xl`; spacing `none`, `xs`, `sm`, `md`, `lg`, `xl`; line height `tight`, `snug`,
`normal`, `relaxed`, `loose`. Presentation fields accept responsive maps of these
names, for example `font_size_px: {mobile: "md", desktop: "lg"}`. Read the field
schema: counts, widths and breakpoints are not spacing steps. Pixel values are
explicit exceptions, not the default authoring method. Configure scales in
`design_scales`, then reuse them in role styles and blocks.

Use exact Google Fonts family names. Published sites self-host them by default
(`fonts.delivery: self_hosted`); a name Google does not serve falls back
silently, and the preview loads fonts from Google, so check fonts on the
published address (qa/checklist.md). `delivery: google` sends each visitor's IP
address to Google: a privacy decision for the owner.

Record deliberate exceptions in `decisions.md`, with source/block, reason and
review criteria (for example white text on a photograph). Run `lint_design_tokens`
before launch and after major design changes. It warns, never blocks launch.
Use the starter's `scripts/typeroll/color_tokens.py` for an exact-match dry run;
review the plan before applying it in a dedicated Version. Equal hex values can
mean different roles: never automatically choose between background and text.
Verify a primary/surface change in a test Version across header, footer, cards,
menus and buttons, then restore the test settings. Do not republish automatically.

## Fluid typography and component rhythm

Core 0.2.114 / MCP 0.45.85 / capabilities 0.55.0 adds responsive scales.
Check the connected versions before using this contract. New sites use render
version 10. For an existing site, test a Version first; upgrading rendering
and replacing existing roles are separate, deliberate choices.

Use `fonts.size_base` (default 16), `typography.ratio_mobile` (1.2),
`typography.ratio_desktop` (1.25), `typography.rhythm` (1), and
`typography.line_length` (65 ch). Set the controls once, then use named type,
spacing and line-height steps. `apply_standard_styles` uses those steps;
`overwrite: true` resets existing roles, so review their current values first.
Explicit sizes and breakpoint overrides still win and are not silently migrated.

Heading role margins belong to editorial flow. Component titles use their own
padding/gap, and opening headings in containers/sections add no top margin.
Use role-linked `core/heading` size `auto` or `theme`; explicit hero sizes remain
deliberate exceptions. Do not compensate with per-card negative margins.
Compare 375, 768 and 1280px in Site settings → Design and in a full site preview.
After a rendering upgrade/rebuild, recheck cards, boxed headings, leading text
and webfonts. Boxes should get their outer air from padding. Keep exceptions
in decisions.md, and run lint_design_tokens before launch.
