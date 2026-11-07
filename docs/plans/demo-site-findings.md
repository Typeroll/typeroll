# Platform findings from the demo site

Status: open list (2026-11-06). The demo site (`packages/portal/tests/layout/demo-site.ts`)
is an architecture studio with eight typical pages, real Swedish copy,
images, every core block type and no custom CSS. It is built by the real
static renderer and checked by the layout contract. Building it the way a
customer would surfaced the platform issues below.

## Fixed at render version 14

- **Component headings lost their bottom margin.** With platform CSS in
  layers, the low-specificity rule that resets component heading margins
  sat in the styles layer and beat the blocks' own spacing. Hero, feature
  row and card headings touched the text under them. The content well,
  block CSS and site styles now share one layer, in the order and with the
  specificity they had before.
- **Section dividers covered the block above.** A wave or curve divider is
  drawn into the previous block. Sections with a divider now reserve the
  divider's height as margin.
- **Optional images showed as broken.** The sanitizer drops an empty `src`,
  so the `img[src=""]` hide rules never matched; an absent testimonial logo
  showed a broken-image icon and its alt text. Images without a source are
  now hidden.
- **Unknown icon names rendered as text.** `ruler` printed "rul er". An
  ASCII icon name that does not exist now renders nothing; emoji still
  render. (Ungated: the previous output was never intended.)
- **Team photos filled a phone screen.** Photos are capped at 16rem in a
  one-column layout.
- **Containers in columns, tabs and grid cells shrank and centred.** Auto
  inline margins in a flex column shrink an item to its content. Constrained
  containers there now start at the content edge and fill up to their
  maximum width.
- **Table cells broke words at arbitrary letters.** Cells keep words whole
  and hyphenate; a table wider than its column scrolls.
- **The price and its period ran together** ("18 000 krfast pris").
- **Logos were tiny with large gaps** in a logo cloud on phones. Logos keep
  at least 7rem, rows are compact.
- **Small touch targets** in card titles and the table of contents.
- **Search fields centred inside columns** instead of aligning with the
  content beside them.
- **Footer link rows were loose on phones.** Footer links kept 44px touch
  targets and a 24px row gap, so wrapped rows sat about 68px apart. The
  footer starter now stacks its links one per line on phones and puts them
  in a row from tablet up, with compact 24px targets (WCAG 2.2 AA) and an
  8px gap. Decided by the owner on 2026-11-07. (Starter data: existing
  footers keep their links.)
- **Content edges differed between block types on wide screens.** Hero,
  feature row and call to action had their own maximum widths, and the
  content well held every other top-level block at 1080px. Every block now
  takes its content width from shared narrow, normal and wide widths, and
  the layout contract checks that top-level blocks of the same width start
  at the same edge.

## Open: needs a decision or its own change

1. **Interface defaults are English whatever the site language.** A Swedish
   site shows "Learn more", "Home", "On this page", "Menu", "Get started",
   "Search…", "Download PDF", "Continue", "Previous/Next" and
   "Explore options" unless every block sets its own label. `uiText()`
   already localizes three words in about 50 languages.
   Proposal: an untouched default label renders the site language's word
   (as breadcrumbs already do for language sections), with translations for
   the full label set.
2. **Dates are not localized.** Post cards and the article date show
   `2026-10-12`; the template default format is English (`MMM D, YYYY`).
   Dates should follow the site language ("12 okt. 2026").
3. **The page list lists every page by default.** Without a filter, a blog
   index lists Home, Contact and Prices too. Default to the current page's
   children, or require a source.
4. **Collection blocks hide item fields.** The feature grid does not expose
   the item link label; changing it needs `item_overrides`, which no editor
   or agent will find. Expose the item fields that carry text.
5. **Slot containers drop `children` silently.** Columns and tabs render
   only `slots`; content given as children disappears without a warning.
   Check that the API, MCP and editor reject or convert it.
6. **Nested components keep section padding.** A feature row inside a tab
   keeps its section-level vertical padding. Components inside another block
   should drop their outer padding by default.
8. **Template interface words cannot be set per site.** The article
   starter's breadcrumb home label and outline title are English; a site
   has to edit its template copy.
10. **Feature rows keep two columns in a narrow cell.** A feature row in a
    grid cell or a narrow column stays side by side at desktop widths, so
    its heading breaks after every word. It should stack by the width of
    its container (container queries, design phase 4).
