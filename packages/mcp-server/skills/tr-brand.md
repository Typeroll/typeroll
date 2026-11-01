---
name: tr-brand
description: Use when the user asks to create a brand identity, design system, or visual style for a site. Triggers on "create a brand", "design the look", "choose colors", "pick fonts", "make it look like [reference]", or "rebrand the site". Produces a cohesive palette, typography scale, and CSS custom properties applied to an existing site.
---

# Design a brand identity for a Typeroll site

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


> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks and partials) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


This skill turns a brief (or a reference URL/screenshot) into a complete
visual design system applied to the site's settings and partials.

## Preconditions

- Site exists and MCP is configured.
- You have at least one of: industry, mood words, reference URL, existing
  logo colors, or competitor sites to contrast with.

## Step 1 — Gather context

Ask (or infer from the brief):

1. **Industry + audience.** Law firm → formal, trust. Café → warm, approachable.
   Tech startup → clean, modern. Interior design → refined, editorial.
2. **Mood words.** 3–5 adjectives the brand should feel: "minimal, Nordic,
   calm" or "bold, energetic, playful".
3. **Reference.** A URL, a screenshot, or a competitor they like (and what
   they want to be different from it).
4. **Must-keep.** Existing logo color? Legal industry color conventions?

If the user provided a URL, fetch it and note the dominant colors,
typeface categories, and layout density.

## Step 2 — Build the palette

The site palette uses semantic colour roles (hex values belong here in settings):

| Token | Role | Design rule |
|---|---|---|
| `primary` | Brand identity. CTA buttons, active nav, links. | High contrast on `background`. |
| `secondary` | Header, footer, darker sections. | Darker or more neutral than primary. |
| `accent` | Highlights, price tags, badges, hover states. | High-energy complement. |
| `background` | Page background. | Near-white for light themes, near-black for dark. |
| `surface` | Cards, input boxes, code blocks. | Slightly off from `background`. |
| `text` | Body copy. | ≥4.5:1 contrast ratio on `background`. |
| `text_light` | Secondary labels, captions, placeholders. | ≥4.5:1 on `background`. |

Text on `primary`, `secondary` and `accent` (buttons, badges, tabs,
call-to-action sections, the `on_*` style tokens) is black or white
automatically, chosen by APCA from render version 8. When the brand
specifies it, set `colors.on_primary`, `colors.on_secondary` or
`colors.on_accent` (a hex colour; `null` returns to automatic). The response
lists `on_colors` with each one's APCA Lc and WCAG 2 ratio: button text needs
Lc 60, body text Lc 75. Do not compensate with custom CSS.

**Palette recipes by mood:**

*Nordic / minimal:*
```
primary: #1f2a30   secondary: #142027   accent: #c9b89a
background: #faf8f4  surface: #f2ede5  text: #1f2a30  text_light: #7a7265
```

*Warm / artisan:*
```
primary: #3d2b1f   secondary: #2a1d14   accent: #c8860a
background: #fdf6ee  surface: #f7ede0  text: #1a1008  text_light: #8a7060
```

*Modern / tech:*
```
primary: #2563eb   secondary: #1e293b   accent: #f59e0b
background: #ffffff  surface: #f8fafc  text: #0f172a  text_light: #64748b
```

*Editorial / dark:*
```
primary: #e2c08d   secondary: #0f0f0f   accent: #e2c08d
background: #0f0f0f  surface: #1a1a1a  text: #f5f5f0  text_light: #a0a090
```

Check WCAG contrast ratios mentally: text on background must be ≥4.5:1.
The online tool `https://webaim.org/resources/contrastchecker/` is useful
but not accessible during a tool call — reason about perceived contrast
instead (light grey on white = bad; dark grey on white = fine).

## Step 3 — Choose typefaces

Pick from high-quality Google Fonts pairings:

| Heading | Body | Mood |
|---|---|---|
| Cormorant Garamond | Raleway | Luxury, editorial |
| Playfair Display | Source Sans 3 | Classic, readable |
| DM Serif Display | DM Sans | Contemporary, clean |
| Fraunces | Mulish | Artisan, craft |
| Syne | Inter | Bold, modern |
| Plus Jakarta Sans | Plus Jakarta Sans | Clean, versatile |
| Libre Baskerville | Libre Franklin | Traditional, trustworthy |

Same font for heading and body is fine if it has enough weight variation
(Inter at 700 + 400 works well).

Use the exact Google Fonts family name ("Plus Jakarta Sans", not "plus
jakarta"). Fonts are self-hosted by default (`fonts.delivery: "self_hosted"`,
Core 0.2.130+): when a publication is frozen, Typeroll copies the Google Fonts
CSS and woff2 files (weights 400–700) into the build. The site serves
`/_typeroll/fonts/fonts.css` and the files under `/_typeroll/fonts/`; visitors
never contact `fonts.googleapis.com` or `fonts.gstatic.com`, before or after
consent. A family Google does not serve is skipped without an error and the
browser falls back to the next font in the stack. `system`, or only local
fonts such as Arial, captures nothing. `fonts.delivery: "google"` links the
Google CDN directly and sends every visitor's IP address to Google: that is a
privacy/consent decision for the owner, never your default.

`size_base` should be 16 for most sites; 17–18 for text-heavy editorial
sites; 15 for dense dashboards.

## Step 4 — Apply to the site

One call sets everything:

```
update_site_settings {
  "colors": { ...all 7 tokens },
  "fonts":  { "heading": "...", "body": "...", "size_base": 16 }
}
```

The brand lives in three places that editors can see and change: the
`colors` and `fonts` settings, the design scales, and named Styles (Step 5b).
Font families are set only in `fonts`; the platform loads each family once.
Never load a font again through `custom_css` (`@import`, `@font-face`) or
`scripts_head`: the readiness item `duplicate_fonts` reports it.

Read back to confirm: `read_site_settings`.

**Inside a redesign branch, scope the brand to the branch** — pass
`version="<branch>"` on `update_site_settings` (and `read_site_settings`).
Colors / fonts / logo / custom_css then live on the branch (copy-on-write,
chain-fallback to main for anything you don't override) and don't touch the
live site until you `merge_branch`. This is the correct way to rebrand on a
branch — don't hack the palette into a `:root{}` override in the header
partial just to keep it off live; that's no longer necessary.

### Site icons — always propose them, never leave them empty

Every site gets a favicon + apple touch icon + 192px app icon as part of brand setup:

1. **Brand assets exist** (favicon-*.png, app icon, symbol): upload the
   right sizes via `upload_media_inline` (favicon: 32–64px PNG or SVG;
   apple touch icon: 180×180 PNG; app icon: 192×192 PNG) and set all three in one call:
   `update_site_settings { "favicon": "<url>", "apple_touch_icon": "<url>", "icon_192": "<url>" }`.
2. **No icon assets:** derive a proposal instead of skipping — crop the
   logo's symbol to a square and resize locally (`sips -z 180 180 in.png
   --out icon-180.png` on macOS, or ImageMagick), or generate a simple
   icon candidate with the imagegen lab (see `tr-imagegen`; respect the
   style profile, no text). Upload, set, and tell the user it's a
   proposal they can swap.

A site shipping with the browser's default globe icon is a build gap —
treat icons like the logo: part of done.

## Step 5 — Update partials to use the new palette

Partials that hardcoded hex colors need updating. Fetch the header:

```
read_partial partial_id="header"
```

If it has hardcoded colors, replace them with CSS variable references
(`var(--color-primary)`) and call `replace_partial`:

```
replace_partial partial_id="header" html_content="<updated HTML>"
```

Same for footer.

## Step 5b — Express the typography as styles

Colours and fonts are only half the brand. Put the type scale, weights,
spacing and recurring treatments into the site's named styles (`list_styles`,
`update_style`, `create_style`): body text and H1–H6 apply everywhere; the
eyebrow, lead, quote, buttons and section rhythm are chosen per block with
`style_id`. Set phone values in `base` and grow them in `at.tablet` and
`at.desktop`. Prefer this to custom CSS: editors can see and change styles,
and every page follows.

## Step 6 — Custom CSS only for recorded exceptions

Use `custom_css` only for what settings, scales and Styles cannot express,
and record each rule in `decisions.md` with its reason and the block or
page it serves. Before writing a rule, check `read_block_type` for a field,
part or Style that does the same job. Don't override block classes with
`!important`, restyle every heading or button in CSS, or set a hero's
background image in CSS: the platform cannot then load that image early, and
the readiness item `custom_css_overrides` reports it. Use the block's own
image field instead.

A legitimate exception is a token beyond the 7 base colours, such as a
gradient, a special border radius or a branded highlight colour:

```css
:root {
  --brand-gradient: linear-gradient(135deg, var(--color-primary), var(--color-accent));
  --radius-brand: 2px;                    /* sharp corners for formal brands */
  --letter-spacing-display: -0.03em;     /* tight tracking for display headings */
}
```

Then reference `var(--brand-gradient)` etc. in page HTML and partials.

## Step 4b — Section + layout design defaults

These are non-negotiable defaults the rest of the platform skills inherit (`tr-new-site`, `tr-page-template`). Apply them on every page that has visible sections — they're battle-tested across real customer migrations.

### One signal per section boundary

Use **either** a background-color shift **or** a horizontal divider line at a section transition — never both stacked. They serve the same purpose; stacking them looks busy.

- Default: alternating `.section` / `.section.alt` with a bg shift is enough.
- A standalone divider line (gradient/keyline) is reserved for the hero → body boundary, where the bg already shifts.

### Sections are full-bleed; content is container-width

The section element ALWAYS spans the full viewport (its bg, border, decorative line). Content inside is constrained to a readable column.

**Block-mode pages (the default):** this is native. Top-level
`core/section` blocks are full-bleed out of the box — set `background`
on the section and it runs edge-to-edge, meeting the header with zero
gap; the section's `width` field (narrow/normal/wide/full) constrains
the content column. **NEVER add 100vw negative-margin hacks on block
pages** — they double-bleed and break. Anchor ids / custom classes on
sections are safe from template_capabilities_version ≥ 0.15.3 (older
versions wrapped the section in a div and silently killed full-bleed —
there, put the anchor on a block inside the section).

**HTML-mode pages (`html_content`) only:** the renderer wraps the body
in `<main class="page-content">` with `max-width: var(--container-medium)`
— a section's bg-color rule alone gives a "1080px-wide stripe in the
middle of the page", which is wrong. Every section that has a bg/border
must apply the negative-margin escape:

```css
.my-page .section {
  position: relative;
  margin-left: calc(50% - 50vw);
  margin-right: calc(50% - 50vw);
  width: 100vw;
  padding-block: var(--space-xl);
}
.my-page .section.alt { background: var(--color-surface) }
```

For an HTML-mode hero, inspect the actual `.page-content` top padding before compensating for it. Reuse its variable when available; otherwise document a measured override in `decisions.md`. Do not assume a scale step equals the shell padding. Do NOT wrap the page in `overflow-x: clip` — it cancels the bleed.

### Cards sit directly on the section bg — never on a matching bg

A card with a white bg inside a white-bg section creates a redundant "white plate on white" effect. Two enforcement rules:

1. Cards on the default page bg (`var(--color-background)`) can use `background: var(--color-surface)` + border. ✓
2. Cards on `.section.alt` (which has `background: var(--color-surface)`) must drop their own bg:
   - **Single-card section** (one card in a section): drop all chrome (bg, border, accent line). Just content; the section's bg is the only context.
   - **Grid cards** (multiple side-by-side): keep border for grid separation, drop bg. The card becomes a transparent container with a hairline outline.

   ```css
   .my-page .section.alt .my-expert,
   .my-page .section.alt .my-expert::before { background: transparent; border: 0; padding: 0; display: none }
   .my-page .section.alt .my-grid-card { background: transparent }  /* grid cards keep border */
   ```

Mental model: bg shifts twice before you have a problem — body → section → card. Three shifts feels muddled.

### Gradient-clipped headings need extra line-height for descenders

When using `-webkit-background-clip: text` + `display: inline-block` to render a gradient-filled heading, the inline-block box is sized by `line-height`. With `line-height: 1` (a common "tight" value for display headings) the descenders of g/j/y/p get clipped.

**Rule:** gradient-clipped headings use `line-height: 1.1` or higher, plus `padding-bottom: 0.05em` for belt-and-braces:

```css
.gradient-h1 {
  display: inline-block;
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  line-height: 1.12;
  padding-bottom: 0.05em;
}
```

### Hero copy is not body copy

When porting a page, identify the H1 + tagline pair and leave the body intro inside the body. Don't lift a body sentence up into the hero unless the source has it twice.

Rule: hero gets at most **H1 + one tagline**. Body intro stays in the body. Repeating the same sentence in both places looks accidental.

### Footer architecture: navigate by domain, not by content type

Default footer columns should mirror the user's mental model of the BUSINESS, not the technical content shapes. Anti-pattern: separate "Podcast / Articles / Events / Offers" columns that just list content categories.

Better default:
- **Områden / Domains** — subject domains, what the user wants help with
- **Företaget / Company** — about / services / legal, meta-information about the org

Reserve a third column only when there's a genuinely different surface (locations, languages, partner pages). Don't pad the footer with content-type columns — navigation to those happens via top nav + topic pages.

## Step 7 — Preview, then verify fonts on the published site

```
get_preview_link
```

Open in browser. Check:
- Colors render as intended (not "undefined" or missing)
- Nav text is readable against header background
- Body text has sufficient contrast

The preview loads fonts from Google inside a sandbox, so it proves nothing
about font delivery. After an authorized publish, check the published
temporary/test address:
- `/_typeroll/fonts/fonts.css` has `@font-face` rules for every chosen family.
  A comment instead of rules means Google did not serve that name: fix it.
- Every font file `url(...)` in it returns 200.
- No request goes to `fonts.googleapis.com` or `fonts.gstatic.com`.
- After `await document.fonts.ready`, `[...document.fonts]` has a `loaded`
  face for each family, and headings/body compute to that family.

## Pitfalls

- **Don't set colors without checking the header contrast.** If `primary`
  is light, white nav text becomes unreadable. Either darken `primary` or
  make the header use `secondary`.
- **Custom_css is global.** Rules here apply to every page. Keep it to
  `:root {}` token additions and recorded exceptions. A look that repeats
  is a named Style; a one-off treatment is a block's `custom_class` with a
  rule in that Page's `custom_css`.
- **Font weight on every page.** Two families is fine; a third adds
  measurable LCP impact even when self-hosted. A misspelled family name
  fails silently to the fallback font — verify it as in Step 7.
- **Dark themes need dark surface too.** Setting `background: #0f0f0f`
  but leaving `surface: #f8fafc` (white) breaks every card/input. Always
  update all 7 tokens as a set.
- **The renderer's `.page-content` layout shell (html-mode only).** The
  renderer wraps `html_content` in `<main class="page-content">` with
  constrained `max-width` and default typography. The typography defaults
  now sit inside `:where()` so they have specificity 0 — a customer's
  class rules trivially win. The layout shell (width + padding) is still
  at normal specificity by design: it's what gives a brand-new page
  reasonable margins out of the box. If a section needs to escape the
  shell (full-bleed bg, full-width hero), apply the negative-margin
  pattern shown in Step 4b. Don't fight the shell with `overflow-x`
  hacks. Block-mode pages don't have the width problem — sections are
  natively full-bleed there.
- **The shell's global `img` rule leaks into custom figures.** Both modes
  apply `:where(.page-content) img { margin: …; border-radius: … }`. A
  hand-built image card (rounded clipping wrapper around an `<img>`) gets
  phantom margins inside the wrapper — visible as white bands above and
  below the photo. Zero it explicitly in your figure CSS:
  `.my-figure img { margin: 0; border-radius: 0 }`.

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
