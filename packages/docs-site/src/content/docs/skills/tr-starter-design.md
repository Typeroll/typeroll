---
title: "Starter design system"
description: "Reference for the default design new Typeroll sites start with — CSS variables, spacing, radii, container width, header and footer skeletons. Read it when a site is blank or clearly follows these conventions and you need new markup or CSS to fit in; skip it for sites with their own design."
editUrl: "https://github.com/typeroll/typeroll/edit/main/packages/mcp-server/skills/tr-starter-design.md"
sidebar:
  label: "Starter design"
  order: 3
---

<!-- Generated from packages/mcp-server/skills/tr-starter-design.md by scripts/generate-skill-pages.mjs. Edit the skill, not this page. -->

This is the `tr-starter-design` recipe exactly as the Typeroll MCP server gives it to agents through `list_skills` and `read_skill`. See [Skills and recipes](../overview/) for how agents load recipes.

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

Record deliberate exceptions in `decisions.md`, with source/block, reason and
review criteria (for example white text on a photograph). Run `lint_design_tokens`
before launch and after major design changes. It warns, never blocks launch.
Use the starter's `scripts/typeroll/color_tokens.py` for an exact-match dry run;
review the plan before applying it in a dedicated Version. Equal hex values can
mean different roles: never automatically choose between background and text.
Verify a primary/surface change in a test Version across header, footer, cards,
menus and buttons, then restore the test settings. Do not republish automatically.


## Express the brand through settings, not CSS

Brand colours belong in `colors`, font families in `fonts`, sizes and spacing
in the design scales, and recurring looks in named Styles. Editors can see and
change all of these, and every page follows them. Use `custom_css` only for an
exception recorded in `decisions.md`, and never to load a font a second time,
restyle all headings or buttons, or set a hero background image. Run
`lint_design_tokens` and check the readiness items `duplicate_fonts` and
`custom_css_overrides` in `read_site_readiness` before launch.

The CSS variables below are for those recorded exceptions, HTML-mode pages and
template markup.

A reference for the *default* design that ships with new Typeroll sites.
The customer may have replaced it — always inspect the actual header partial
(`read_partial partial_id="header"`) and an existing page before assuming any
of this is in use. On a site with its own design, mirror what is there.

## CSS variables

Colors (set in site settings `colors`; each key becomes `--color-<key>`,
`text_light` becomes `--color-text-light`):
  --color-primary       brand CTAs, links, accents
  --color-secondary     supporting brand color (rarely used)
  --color-accent        a third highlight (badges, callouts)
  --color-background    page background (the body)
  --color-surface       slightly raised areas (header, footer, cards)
  --color-text          body copy + headings
  --color-text-light    secondary text (captions, meta, footer fine-print)

For subtle borders/dividers that follow the text color without being heavy,
use `color-mix(in srgb, var(--color-text) 8%, transparent)` (6% for very soft).

Spacing scale:
  --spacing-xs (0.25rem)  --spacing-sm (0.5rem)  --spacing-md (1rem)
  --spacing-lg (2rem)     --spacing-xl (4rem)

Layout:
  --container-medium (1080px)  Center page content with
    `max-width: var(--container-medium); margin: 0 auto; padding: var(--spacing-md);`
  --container-narrow (720px) and --container-wide (1400px) exist for prose
    and wide layouts.

Radii:
  --radius-sm (0.25rem)  --radius-md (0.5rem)  --radius-lg (1rem)

Typography (set in site settings `fonts`):
  --font-heading  Use for h1-h6 and brand wordmark
  --font-body     Default for everything else
  --font-size-base (the rem baseline)

Block-mode pages get these through the blocks and named styles; reach for the
variables in custom CSS, HTML-mode pages and template markup.

## Default header skeleton

Surface-tinted bar with a hairline bottom border. Brand text on the left
in the heading font, bold, slight negative letter-spacing. Nav on the
right. Last nav item is typically a primary CTA: `background:
var(--color-primary); color: var(--color-background); border-radius:
var(--radius-md)`.

## Default footer skeleton

Three-column responsive grid (brand+tagline / Site links / Get in touch),
then a fine-print row with copyright + Typeroll attribution. Top border
uses the same color-mix() recipe as the header.

## When to use this

- A brand new site, or one where the header partial still matches this
  layout.
- A page or block where the customer wants something that "fits the rest
  of the site" and the rest follows these conventions.

## When NOT to use this

- The customer has a totally different design (e.g. dark mode, custom
  utility classes, no CSS variables, migrated theme).
- The customer says "use this brand color" — honor their literal request
  instead of substituting a CSS variable.
- Mid-edit on an existing page that doesn't follow these conventions —
  match what's already there.
- Choosing a new palette or fonts is brand work (the MCP recipe `tr-brand`),
  not this reference.

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
