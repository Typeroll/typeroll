# Styles, reusable blocks and render versions

Status: accepted direction (2026-10-01). Implement in the order of the phases
below; each phase ships on its own and leaves existing sites unchanged.

## Problems this solves

Rebuilding autopilot.se on blocks exposed platform gaps, not site mistakes:

- There is no named, reusable style. Appearance is either per-block values or
  a class inside raw HTML. Only `core/button` has variants.
- `style_overrides.custom_class` exists for every block but the editor never
  shows it, and it lands on the block wrapper, so `.eyebrow` must be written
  `.eyebrow .block-heading-text`.
- `core/prose` is an HTML bucket. Any class, heading or image forces the raw
  source editor.
- The heading eyebrow has fixed platform styling and no semantic grouping.
- Design values are thin: colours and two fonts. Block CSS references
  `--color-primary-fg`, `--color-border` and `--color-bg-subtle`, which are
  never defined. Nothing checks text contrast.
- Platform CSS and markup are unversioned. A Core change restyles every site
  on its next build (the 2026-09-21 link underline degraded autopilot.se).
- There is no shared section that updates everywhere, and no copy-in section
  starter.

## Principles

- Content, semantics and appearance are separate fields. A heading's level is
  semantic; its look is a style.
- Appearance is named and reused. A one-off value is the exception.
- Existing sites never change appearance without an explicit, previewed
  upgrade.
- Everything the UI can do, the authenticated API and MCP can do.
- Text must meet WCAG AA contrast (4.5:1, 3:1 for large text) against its
  background. Light grey on white is never acceptable, in sites or in the
  portal.

## Phase 1: render versions

`SiteSettings.render_version` (integer). A missing value means 1, the output
Core produced when versions were introduced. New sites are created at
`LATEST_RENDER_VERSION`.

- Any change to platform CSS or block markup that alters an existing page is
  gated on `renderVersion >= N` and documented in `RENDER_VERSIONS`. A pure bug
  fix that restores intended output may ship ungated, with a changelog note.
- Reference tests snapshot every core block's markup and the shared platform CSS
  per render version. Changing output for a released version fails the tests
  until the change is gated or explicitly accepted as a fix.
- Preview accepts a target version. The portal shows the current version,
  what newer versions change, a "Preview with version N" link and an Upgrade
  action. Upgrading is a settings write and is reversible.
- Visual comparison runs in the agent, not on the server: the
  `tr-upgrade-rendering` skill screenshots each page at both versions and
  reports differences before asking to upgrade.

## Phase 2: design values and styles

**Design values** are site-wide tokens: colour palette (named colours plus
on-colour pairs), font families, a type scale and a spacing scale, each with
mobile/tablet/desktop values. They replace hard-coded tokens in
`CONTENT_WELL_CSS` and define every variable blocks reference.

**Styles** are a site library of named, user-created styles. Each style has:

- a name chosen by the author and a stable slug (`s-<slug>` class);
- the block kinds it applies to (text, heading, list, section/container,
  button, image, link);
- structured properties per breakpoint: font, size, weight, line height,
  letter spacing, transform, colour, background, spacing, border, radius;
  colours reference design values;
- optional advanced CSS scoped to the style class.

Blocks gain a `style` field listing compatible styles. Changing a style
changes every use. CSS is generated from the library, so no author needs to
know platform markup.

New sites start with a considered default set: body text, H1–H6, lead,
eyebrow, small text, quote, link, primary/secondary button and section
spacing. The defaults cover every breakpoint. Setting them up is the first step
of building a site (`tr-new-site`).

Agents create or reuse a named style for any appearance that could recur, and
use one-off values only for something clearly unique. Migrations map source
classes to styles instead of keeping classed raw HTML.

Contrast is checked when a style, design value or block colour is saved and in
publication validation.

### Phase 2 as built (Core 0.2.57)

- Styles are stored in `SiteSettings.styles`, so they travel through every
  publication path and are versioned per branch with the settings. API and
  MCP still address them one by one (`/styles/{id}`).
- Element roles (body, h1–h6, link) emit CSS custom properties (`--type-hN`,
  `--hN-weight`, `--hN-leading`, `--hN-tracking`, `--hN-color`, `--body-*`,
  `--link-*`) that platform CSS reads with its previous values as fallbacks.
  A site without styles has identical computed output (verified in Chromium).
- Class styles are `.s-<id>:not(#\#)`: the id-level boost makes a chosen
  style win over the block's default appearance without `!important`.
- Blocks select a style with `style_id` (field type `style`, filtered by
  `style_target`). `BlockType.style_element_class` puts the class on the
  semantic element; `style` was already a variant field on other blocks.
- Derived `on_primary`, `on_secondary`, `on_accent` text colours pick black or
  white for contrast. The default primary became `#2563eb`; `#3b82f6` fails AA.
- Adding standard styles adapts a palette colour that is unreadable on the
  site background to the body text colour instead of failing.

## Phase 3: semantics in core blocks (render version 2)

- `core/heading`: an optional kicker (eyebrow) and subtitle, each with its own
  style, rendered in an `<hgroup>` so they are not separate headings. Level
  (h1–h6) is independent of the chosen style.
- `style_overrides.custom_class` and `html_id` move to the block's primary
  element (declared per block type), and the inspector shows them under
  Advanced.
- The rich-text editor applies styles per paragraph, like document paragraph
  styles. Only unknown markup falls back to source, with an offer to convert
  it into blocks.

## Phase 4: custom CSS fields

Site and page custom CSS get managed fields in UI, API and MCP: a code editor,
syntax validation, warnings for selectors that target platform internals
(`[data-block]`, `.block-*`) instead of styles or classes, and live preview.

## Phase 5: reusable blocks

Two distinct concepts:

- **Global blocks**: one stored source, referenced from many pages and
  partials. Editing it updates every use; pages only hold a reference.
- **Block templates**: saved section starters. Inserting one copies its blocks
  into the page; later edits affect only that page.

Both work in the UI, API and MCP, and both use styles rather than raw HTML.
