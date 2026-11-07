# Platform findings from the demo site

Status: all fixed at render version 14 (2026-11-07). The demo site (`packages/portal/tests/layout/demo-site.ts`)
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

- **Interface defaults were English whatever the site language** (finding 1),
  and template interface words could not follow the site (finding 8). A
  label left at its English default (Learn more, On this page, Menu, Open
  menu, Previous, Next, Download PDF, Continue, Get started, Search, Home)
  now renders in the page language, in all 50 built-in languages; an
  authored label wins. Starter templates hold the English defaults, so
  they follow the site too.
- **Dates were not localized** (finding 2). Page and card dates read in the
  page language ("12 okt. 2026"); the Page date block's format setting now
  applies, and the site setting `date_format` sets the default.
- **The page list listed every page by default** (finding 3). An unfiltered
  list of ordinary Pages lists the current Page's children.
- **The feature grid hid the card link label** (finding 4). Each card has
  its own link label field; the other collection blocks already exposed
  their text fields.
- **Slot containers dropped children silently** (finding 5). Blocks given as
  children of columns, tabs or a block menu move to the end of its first
  slot when saved, and the save returns a `children_in_slot_block` warning.
- **Nested components kept section padding** (finding 6). A feature row in a
  tab, column, grid cell or container drops its default outer padding and
  fills the block around it.
- **Feature rows kept two columns in a narrow cell** (finding 10). The row
  stacks by its own width (a container query).

## Open

None. Per-site settings that came up while fixing these are collected in
[site-settings-proposals.md](site-settings-proposals.md).
