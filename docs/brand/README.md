# Typeroll brand guide

How the Typeroll identity works and how to use it in product surfaces.
The SVG files in this directory are the canonical, web-ready set —
exported from the master EPS files (kept outside the repo), cleaned, and
tightly cropped.

## The idea

The identity is one shape looked at twice.

**The wheel** (`typeroll-symbol-full`) is six serif capital **T**s — the
"type" — rotated around a common hub. Their stems form the spokes and
their serifs close the rim: a printing wheel, type that literally rolls.

**The mark** (`typeroll-symbol`) is what the wheel *isn't*: the negative
space between the six T:s. Six petal-shaped counters form a rosette — a
typographic fleuron, the ornament tradition the name plays on. It reads
as a flower at first glance and reveals the T:s on the second.

That figure–ground flip is the brand. The wheel explains the mark; the
mark is the everyday face. Surfaces that get both (a 404, an about page,
a deploy screen) can stage the reveal — see "Creative use" below.

**The main logo** (`typeroll-main`) is the rosette mark + the wordmark
"Typeroll".

## Files

| File | What | Use on |
|---|---|---|
| `typeroll-main.svg` | Mark + wordmark, ink | Light backgrounds |
| `typeroll-main-white.svg` | Mark + wordmark, white | Dark backgrounds (portal sidebar) |
| `typeroll-symbol.svg` | Rosette mark, ink | Light backgrounds, favicon, small spaces |
| `typeroll-symbol-white.svg` | Rosette mark, white | Dark backgrounds |
| `typeroll-symbol-full.svg` | The T-wheel, ink | Storytelling surfaces, loading states |
| `typeroll-symbol-full-white.svg` | The T-wheel, white | Dark storytelling surfaces |

Deployed copies: `packages/portal/public/brand/` (sidebar + login logos)
and `packages/portal/public/favicon.svg` (the rosette with a
`prefers-color-scheme` style so it stays visible in dark browser chrome).
If a file here changes, refresh those copies.

The paths inside every SVG carry **no fill** — they inherit. The `-white`
variants just set `fill="#FFFFFF"` on the root. When inlining the SVG in
markup you can instead set `fill="currentColor"` on the root and let CSS
color it.

## Color

The marks are strictly monochrome — the negative space does the talking.

- Ink on light: near-black, e.g. `#16161A` (the portal's sidebar black).
- White on dark: `#FAFAFA` / `#FFFFFF`.
- One color per placement. Never recolor individual paths, never add
  gradients or outlines, never fill the counters — the empty space *is*
  the mark.

## Sizing and clear space

- Minimum sizes: symbol ≥ 16 px, wheel ≥ 24 px, main logo ≥ 90 px wide.
- Clear space around any mark: at least one petal-width (≈ 1/4 of the
  symbol's height) on every side.
- The main logo's aspect ratio is ≈ 4.6:1 (248.6 × 53.9 viewBox units).

## Typography

The wordmark is set in **MenoText Regular** (Meno, Richard Lipton /
Font Bureau → Type Network) — and it is **outlined in the logo files**,
so nothing on the web ever needs the font installed to render the logo.

**As a webfont: not recommended.** Meno is a commercial family; web use
requires a paid Type Network web license per domain/pageview tier, and it
is a high-contrast text serif drawn for print — at UI sizes on screens
the thin strokes shimmer. The logo carries the serif voice; let UI text
stay in the product's sans (Geist in the portal).

If marketing pages ever want a serif that harmonizes with the wordmark
without licensing Meno, free old-style faces in the same spirit:
**EB Garamond** or **Spectral** (Google Fonts). Use them for display
sizes only; don't try to fake the wordmark with them.

## Creative use

Patterns that exploit the identity rather than just stamp it:

- **Portal sidebar** *(implemented)*: `typeroll-main-white.svg` on the
  near-black sidebar.
- **Favicon** *(implemented)*: the rosette as `favicon.svg`, ink in light
  browser chrome, white in dark via `prefers-color-scheme`.
- **Loading / working states**: the *wheel* slowly rolling is the natural
  spinner — type that rolls while the press works:

  ```css
  .tr-spinner { animation: tr-roll 2.4s linear infinite; }
  @keyframes tr-roll { to { transform: rotate(60deg); } }
  ```

  60° per cycle = one T-position; the wheel's six-fold symmetry makes the
  loop seamless. Keep it slow and silent — press, not fidget spinner.
- **The reveal**: on storytelling surfaces (about, 404, deploy-done),
  cross-fade `symbol-full` → `symbol` in place. Same size, same center —
  the T:s dissolve and the flower they were hiding remains. This is the
  one place both marks may appear together.
- **Watermark / empty states**: the rosette at 240 px+, 4–6 % opacity,
  bleeding off a corner. One per view.
- **Petal as detail**: a single petal (one counter of the rosette) can
  serve as a list bullet or accent in brand collateral — sparingly, and
  never as a replacement for the mark.

## Don'ts

- Don't rotate the rosette to "fix" its orientation — petal-up is correct
  (it mirrors the T-stem positions in the wheel).
- Don't pair the wheel and rosette side-by-side as if they were two
  logos; the relationship is sequential (reveal), not parallel.
- Don't set product UI text in the wordmark's serif.
- Don't stretch, outline, shadow, or gradient any mark.
