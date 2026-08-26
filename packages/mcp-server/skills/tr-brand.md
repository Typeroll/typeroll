---
name: tr-brand
description: Use when the user asks to create a brand identity, design system, or visual style for a site. Triggers on "create a brand", "design the look", "choose colors", "pick fonts", "make it look like [reference]", or "rebrand the site". Produces a cohesive palette, typography scale, and CSS custom properties applied to an existing site.
---

# Design a brand identity for a Typeroll site

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
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

A Typeroll site uses 7 color tokens:

| Token | Role | Design rule |
|---|---|---|
| `primary` | Brand identity. CTA buttons, active nav, links. | High contrast on `background`. |
| `secondary` | Header, footer, darker sections. | Darker or more neutral than primary. |
| `accent` | Highlights, price tags, badges, hover states. | High-energy complement. |
| `background` | Page background. | Near-white for light themes, near-black for dark. |
| `surface` | Cards, input boxes, code blocks. | Slightly off from `background`. |
| `text` | Body copy. | ≥4.5:1 contrast ratio on `background`. |
| `text_light` | Secondary labels, captions, placeholders. | ≥3:1 on `background`. |

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

`size_base` should be 16 for most sites; 17–18 for text-heavy editorial
sites; 15 for dense dashboards.

## Step 4 — Apply to the site

One call sets everything:

```
update_site_settings {
  "colors": { ...all 7 tokens },
  "fonts":  { "heading": "...", "body": "...", "size_base": 16 },
  "custom_css": "/* optional: utility classes or @keyframes */"
}
```

Read back to confirm: `read_site_settings`.

**Inside a redesign branch, scope the brand to the branch** — pass
`version="<branch>"` on `update_site_settings` (and `read_site_settings`).
Colors / fonts / logo / custom_css then live on the branch (copy-on-write,
chain-fallback to main for anything you don't override) and don't touch the
live site until you `merge_branch`. This is the correct way to rebrand on a
branch — don't hack the palette into a `:root{}` override in the header
partial just to keep it off live; that's no longer necessary.

### Site icons — always propose them, never leave them empty

Every site gets a favicon + apple touch icon as part of brand setup:

1. **Brand assets exist** (favicon-*.png, app icon, symbol): upload the
   right sizes via `upload_media_inline` (favicon: 32–64px PNG or SVG;
   apple touch icon: 180×180 PNG) and set BOTH in one call:
   `update_site_settings { "favicon": "<url>", "apple_touch_icon": "<url>" }`.
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

## Step 6 — Custom CSS for advanced tokens (optional)

If the brand needs things beyond the 7 base tokens — e.g. a gradient,
a special border radius, or a branded highlight color — add them via
`custom_css`:

```css
:root {
  --brand-gradient: linear-gradient(135deg, var(--color-primary), var(--color-accent));
  --radius-brand: 2px;                    /* sharp corners for formal brands */
  --letter-spacing-display: -0.03em;     /* tight tracking for display headings */
}
```

Then reference `var(--brand-gradient)` etc. in page HTML and partials.

## Step 4b — Section + layout design defaults

These are non-negotiable defaults the rest of the platform skills inherit (`tr-new-site`, `tr-directory`, `tr-collection-template`). Apply them on every page that has visible sections — they're battle-tested across real customer migrations.

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
  padding: 74px 0;
}
.my-page .section.alt { background: #fff }
```

The first section (hero) also wants `margin-top: -32px` to cancel `.page-content`'s top padding. Do NOT wrap the page in `overflow-x: clip` — it cancels the bleed.

### Cards sit directly on the section bg — never on a matching bg

A card with a white bg inside a white-bg section creates a redundant "white plate on white" effect. Two enforcement rules:

1. Cards on the default page bg (`var(--color-background)`) can use `background: #fff` + border. ✓
2. Cards on `.section.alt` (which has `background: #fff`) must drop their own bg:
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

## Step 7 — Preview

```
get_preview_link
```

Open in browser. Check:
- Colors render as intended (not "undefined" or missing)
- Fonts load (Google Fonts link is in `<head>`)
- Nav text is readable against header background
- Body text has sufficient contrast

## Pitfalls

- **Don't set colors without checking the header contrast.** If `primary`
  is light, white nav text becomes unreadable. Either darken `primary` or
  make the header use `secondary`.
- **Custom_css is global.** Rules here apply to every page. Keep it to
  `:root {}` token additions and truly global utilities. Page-specific
  styles go in the page's HTML `<style>` block.
- **Google Fonts load time.** Two different font families is fine; three
  adds measurable LCP impact. Stick to two families with variable-font
  versions when possible.
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
