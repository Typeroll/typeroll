---
name: tr-starter-design
description: Reference for the default design new Typeroll sites start with — CSS variables, spacing, radii, container width, header and footer skeletons. Read it when a site is blank or clearly follows these conventions and you need new markup or CSS to fit in; skip it for sites with their own design.
---

# Starter design system

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
