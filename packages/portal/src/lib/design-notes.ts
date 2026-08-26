/**
 * Reference docs for the starter design system that ships with new sites.
 *
 * Exposed to the AI chat via the `read_design_notes` tool. The prompt does
 * NOT assume this design is in use — the customer may have replaced the
 * header/footer with a totally different style, hardcoded their own CSS,
 * or migrated from a WordPress theme that doesn't follow any of these
 * conventions. The AI's instruction is to inspect existing partials/pages
 * first; this doc is only the fallback when the site looks blank or when
 * the existing content clearly follows the starter conventions.
 */

export const DESIGN_NOTES_STARTER = `# Starter design system

A reference for the *default* design that ships with new Typeroll sites.
The customer may have replaced it — always inspect the actual header partial
and an existing page before assuming any of this is in use.

## CSS variables

Colors:
  --color-primary       brand CTAs, links, accents
  --color-secondary     supporting brand color (rarely used)
  --color-accent        a third highlight (badges, callouts)
  --color-background    page background (the body)
  --color-surface       slightly raised areas (header, footer, cards)
  --color-text          body copy + headings
  --color-text-light    secondary text (captions, meta, footer fine-print)

For subtle borders/dividers that follow the text color without being heavy,
use \`color-mix(in srgb, var(--color-text) 8%, transparent)\` (6% for very soft).

Spacing scale:
  --spacing-xs (0.25rem)  --spacing-sm (0.5rem)  --spacing-md (1rem)
  --spacing-lg (2rem)     --spacing-xl (4rem)

Layout:
  --container-medium (1080px)  Center page content with
    \`max-width: var(--container-medium); margin: 0 auto; padding: var(--spacing-md);\`

Radii:
  --radius-sm (0.25rem)  --radius-md (0.5rem)  --radius-lg (1rem)

Typography:
  --font-heading  Use for h1-h6 and brand wordmark
  --font-body     Default for everything else
  --font-size-base (the rem baseline)

## Default header skeleton

Surface-tinted bar with a hairline bottom border. Brand text on the left
in the heading font, bold, slight negative letter-spacing. Nav on the
right. Last nav item is typically a primary CTA: \`background:
var(--color-primary); color: var(--color-background); border-radius:
var(--radius-md)\`.

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
`;
