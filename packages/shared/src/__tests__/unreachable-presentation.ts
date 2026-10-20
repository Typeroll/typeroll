// Literal presentational declarations in core block CSS that no field, style
// or variable reaches yet, at the latest render version. Checked by
// presentation-settings.test.ts ("every presentational value a core block
// writes is reachable"); see presentation-audit.ts for what counts.
//
// Grouped by block. Declaring parts for a block (docs/plans/block-parts.md)
// makes its entries reachable: delete them, and the test fails until every
// stale entry is gone. A new unreachable declaration is never added here
// without a reason that says why a site does not need to change it.

/** The hero video pause control: an accessibility control, not design. */
const VIDEO_CONTROL = 'the background video pause control (WCAG 2.2.2) sits on moving video: its dark disc and white icon stay visible on any frame, which no contrast check of a style can measure, so every site keeps this look';

/** The table of contents indents subheadings under their heading. */
const TOC_INDENT = 'the indent shows which heading a subheading belongs to; the indent field turns it off, and a style sets no inline margins (the item part takes the rest of the item\'s look)';

/** Grouped repeater output: each group is a section holding its title and its own repeater root, outside the reach of parts. */
const REPEATER_GROUP_TITLE = 'the Group title style field (group_title_style_id) puts its style class on every group title, margins included; the title renders outside the repeater root, where no part reaches';

const REPEATER_GROUP_SPACE = 'the space between two group sections, outside every repeater root, where neither a part nor style_overrides reach; a Group title style adds space above each title (space_before)';

/** The breadcrumb separator: generated content, spaced inline. */
const BREADCRUMB_SEPARATOR = 'the separator is each item\'s ::after, and no style property sets inline margins; the item part\'s style sets it in its advanced CSS (&:not(:last-child)::after)';

export const UNREACHABLE_PRESENTATION: Record<string, Record<string, string>> = {
  'core/hero': {
    '[data-block="hero"][style*="--layout:full-image"]:not([style*="--bg-image:url()"]) { color: white }': 'text over the full-width image; the eyebrow, heading, subheading and button parts each take a style with their own colour, and the overlay part sets how dark the image is',
    '[data-block="hero"] > .block-hero-video-toggle { border-radius: 50% }': VIDEO_CONTROL,
    '[data-block="hero"] > .block-hero-video-toggle { background: rgba(0,0,0,0.6) }': VIDEO_CONTROL,
    '[data-block="hero"] > .block-hero-video-toggle { color: #fff }': VIDEO_CONTROL,
  },
  'core/icon_box': {
    '[data-block="icon_box"] .block-iconbox-heading a { text-decoration: none }': 'the heading link renders only when the whole card is the link (whole_card_link), instead of the link part; it takes the heading part\'s look: colour inherits, and the heading part\'s decoration underlines it (a parent\'s underline draws through the link)',
  },
  'core/navigation': {
    '[data-block="navigation"] a[aria-current="page"] { text-decoration-thickness: 0.14em }': 'the underline weight of the current page link shows only when a style underlines it (navigation links have no underline of their own); that style\'s advanced CSS can set the thickness',
  },
  'core/post_card': {
    '[data-block="post_card"] .block-postcard-actions a:hover { text-decoration-thickness: 2px }': 'text-decoration-thickness is not a style property: the hover underline of the action and download links shows only with the underline, which their parts\' hover decoration removes (none), and a part style\'s advanced CSS (`&:hover { text-decoration-thickness: … }`) changes its thickness',
  },
  'core/repeater': {
    '.tr-repeater-group + .tr-repeater-group { margin-top: 2rem }': REPEATER_GROUP_SPACE,
    '.tr-repeater-group-title { margin: 0 0 0.75rem }': REPEATER_GROUP_TITLE,
  },
  'core/table_of_contents': {
    '[data-block="table_of_contents"]:not([data-indent="false"]) li[data-level="3"] { margin-left: 1rem }': TOC_INDENT,
    '[data-block="table_of_contents"]:not([data-indent="false"]) li[data-level="4"] { margin-left: 2rem }': TOC_INDENT,
  },
  'form/slider': {
    '[data-block="form_slider"] .form-slider-value { margin-left: 0.4rem }': 'the space between the label and its inline value is horizontal; a style sets vertical space only (space_before, space_after), and the value part\'s padding adds to it',
  },
  'template/page_breadcrumbs': {
    '[data-block="breadcrumbs"] li:not(:last-child)::after { margin-inline: 0.35rem }': BREADCRUMB_SEPARATOR,
  },
};
