// Literal presentational declarations in core block CSS that no field, style
// or variable reaches yet, at the latest render version. Checked by
// presentation-settings.test.ts ("every presentational value a core block
// writes is reachable"); see presentation-audit.ts for what counts.
//
// Grouped by block. Declaring parts for a block (docs/plans/block-parts.md)
// makes its entries reachable: delete them, and the test fails until every
// stale entry is gone. A new unreachable declaration is never added here
// without a reason that says why a site does not need to change it.

/** The block has no parts yet; the declaration waits for them. */
const NO_PARTS_YET = 'parts not declared yet (docs/plans/block-parts.md)';

/** The hero video pause control: an accessibility control, not design. */
const VIDEO_CONTROL = 'the background video pause control keeps one accessible look on every site (WCAG 2.2.2); it is not a design element';

/** The table of contents indents subheadings under their heading. */
const TOC_INDENT = 'the indent shows which heading a subheading belongs to; the indent field turns it off, and a style sets no inline margins (the item part takes the rest of the item\'s look)';

export const UNREACHABLE_PRESENTATION: Record<string, Record<string, string>> = {
  'core/columns': {
    '[data-block="columns"] { gap: 2rem }': NO_PARTS_YET,
    '[data-block="columns"][data-gap="sm"] { gap: 1rem }': NO_PARTS_YET,
    '[data-block="columns"][data-gap="lg"] { gap: 3rem }': NO_PARTS_YET,
  },
  'core/hero': {
    '[data-block="hero"][style*="--layout:full-image"]:not([style*="--bg-image:url()"]) { color: white }': 'text over the full-width image; the eyebrow, heading, subheading and button parts each take a style with their own colour, and the overlay part sets how dark the image is',
    '[data-block="hero"] > .block-hero-video-toggle { border-radius: 50% }': VIDEO_CONTROL,
    '[data-block="hero"] > .block-hero-video-toggle { background: rgba(0,0,0,0.6) }': VIDEO_CONTROL,
    '[data-block="hero"] > .block-hero-video-toggle { color: #fff }': VIDEO_CONTROL,
  },
  'core/icon_box': {
    '[data-block="icon_box"] .block-iconbox-heading a { text-decoration: none }': 'the heading link renders only when the whole card is the link (whole_card_link), instead of the link part; it takes the heading part\'s look: colour inherits, and the heading part\'s decoration underlines it (a parent\'s underline draws through the link)',
  },
  'core/image': {
    '[data-block="image"][data-radius="md"] img { border-radius: 0.5rem }': NO_PARTS_YET,
    '[data-block="image"][data-radius="lg"] img { border-radius: 1.25rem }': NO_PARTS_YET,
    '[data-block="image"][data-radius="xl"] img { border-radius: 1.75rem }': NO_PARTS_YET,
    '[data-block="image"] .block-image-caption { padding: 0.5rem 0 }': NO_PARTS_YET,
    '[data-block="image"] .block-image-caption { font-size: 0.875rem }': NO_PARTS_YET,
    '[data-block="image"] .block-image-caption { opacity: 0.7 }': NO_PARTS_YET,
  },
  'core/list': {
    '[data-block="list"] ul { padding-inline-start: 1.5rem }': NO_PARTS_YET,
    '[data-block="list"] ol { padding-inline-start: 1.5rem }': NO_PARTS_YET,
    '[data-block="list"] ul { margin: 1rem 0 }': NO_PARTS_YET,
    '[data-block="list"] ol { margin: 1rem 0 }': NO_PARTS_YET,
    '[data-block="list"] li { margin: .35rem 0 }': NO_PARTS_YET,
    '[data-block="list"][data-marker="check"] li { padding-inline-start: 1.5em }': NO_PARTS_YET,
  },
  'core/navigation': {
    '[data-block="navigation"] a[aria-current="page"] { text-decoration-thickness: 0.14em }': 'the underline weight of the current page link shows only when a style underlines it (navigation links have no underline of their own); that style\'s advanced CSS can set the thickness',
  },
  'core/navigation_links': {
    '[data-block="navigation_links"] > li > a { text-decoration: none }': NO_PARTS_YET,
    '[data-block="navigation_links"] .block-nav-icon { line-height: 1 }': NO_PARTS_YET,
    '[data-block="navigation_links"] a:hover { text-decoration: underline }': NO_PARTS_YET,
  },
  'core/post_card': {
    '[data-block="post_card"] .block-postcard-actions a:hover { text-decoration-thickness: 2px }': 'text-decoration-thickness is not a style property: the hover underline of the action and download links shows only with the underline, which their parts\' hover decoration removes (none), and a part style\'s advanced CSS (`&:hover { text-decoration-thickness: … }`) changes its thickness',
  },
  'core/prose': {
    '[data-block="prose"] h1 { margin: 1.5em 0 0.5em }': NO_PARTS_YET,
    '[data-block="prose"] h2 { margin: 1.5em 0 0.5em }': NO_PARTS_YET,
    '[data-block="prose"] h3 { margin: 1.5em 0 0.5em }': NO_PARTS_YET,
    '[data-block="prose"] h4 { margin: 1.5em 0 0.5em }': NO_PARTS_YET,
    '[data-block="prose"] ul { margin: 0 0 1em 1.5em }': NO_PARTS_YET,
    '[data-block="prose"] ol { margin: 0 0 1em 1.5em }': NO_PARTS_YET,
    '[data-block="prose"] a { text-underline-offset: .15em }': NO_PARTS_YET,
    '[data-block="prose"] th { padding: 0.5rem }': NO_PARTS_YET,
    '[data-block="prose"] td { padding: 0.5rem }': NO_PARTS_YET,
    '[data-block="prose"] th { border: 1px solid color-mix(in srgb, currentColor 16%, transparent) }': NO_PARTS_YET,
    '[data-block="prose"] td { border: 1px solid color-mix(in srgb, currentColor 16%, transparent) }': NO_PARTS_YET,
  },
  'core/repeater': {
    '[data-block="repeater"] > .tr-carousel-controls { gap: 0.5rem }': NO_PARTS_YET,
    '[data-block="repeater"] > .tr-carousel-controls { margin-top: 0.75rem }': NO_PARTS_YET,
    '[data-block="repeater"] .tr-carousel-button { border: 1px solid currentColor }': NO_PARTS_YET,
    '[data-block="repeater"] .tr-carousel-button { border-radius: 50% }': NO_PARTS_YET,
    '[data-block="repeater"] .tr-carousel-button:disabled { opacity: 0.4 }': NO_PARTS_YET,
    '[data-block="repeater"] .tr-carousel-dot { padding: 7px }': NO_PARTS_YET,
    '[data-block="repeater"] .tr-carousel-dot { border-radius: 50% }': NO_PARTS_YET,
    '[data-block="repeater"] .tr-carousel-dot { opacity: 0.35 }': NO_PARTS_YET,
    '[data-block="repeater"] .tr-carousel-dot[aria-current="true"] { opacity: 1 }': NO_PARTS_YET,
    '.tr-repeater-group + .tr-repeater-group { margin-top: 2rem }': NO_PARTS_YET,
    '.tr-repeater-group-title { margin: 0 0 0.75rem }': NO_PARTS_YET,
  },
  'core/table': {
    '[data-block="table"] td { padding: .65rem }': NO_PARTS_YET,
    '[data-block="table"] th { padding: .65rem }': NO_PARTS_YET,
    '[data-block="table"] caption { margin-bottom: .5rem }': NO_PARTS_YET,
    '[data-block="table"][data-density="compact"] td { padding: .3rem }': NO_PARTS_YET,
    '[data-block="table"][data-density="compact"] th { padding: .3rem }': NO_PARTS_YET,
    '[data-block="table"][data-density="relaxed"] td { padding: 1rem }': NO_PARTS_YET,
    '[data-block="table"][data-density="relaxed"] th { padding: 1rem }': NO_PARTS_YET,
    '[data-block="table"][data-borders="rows"] td { border-width: 0 0 1px }': NO_PARTS_YET,
    '[data-block="table"][data-borders="rows"] th { border-width: 0 0 1px }': NO_PARTS_YET,
  },
  'core/table_of_contents': {
    '[data-block="table_of_contents"]:not([data-indent="false"]) li[data-level="3"] { margin-left: 1rem }': TOC_INDENT,
    '[data-block="table_of_contents"]:not([data-indent="false"]) li[data-level="4"] { margin-left: 2rem }': TOC_INDENT,
  },
  'core/tabs': {
    '[data-block="tabs"] .block-tabs-strip { border-bottom: 1px solid #8884 }': NO_PARTS_YET,
    '[data-block="tabs"] .block-tabs-choice { gap: 8px }': NO_PARTS_YET,
    '[data-block="tabs"]>.block-tabs-toggle { gap: 8px }': NO_PARTS_YET,
    '[data-block="tabs"] .block-tabs-choice { text-decoration: none }': NO_PARTS_YET,
    '[data-block="tabs"]>.block-tabs-toggle { text-decoration: none }': NO_PARTS_YET,
    '[data-block="tabs"] .block-tabs-icon { line-height: 1 }': NO_PARTS_YET,
    '[data-block="tabs"][data-style="underline"] [aria-selected="true"] { box-shadow: inset 0 -3px currentColor }': NO_PARTS_YET,
    '[data-block="tabs"][data-style="boxed"] .block-tabs-choice { border: 1px solid #8884 }': NO_PARTS_YET,
    '[data-block="tabs"][data-collapse-mode="panels"] [aria-selected="true"][aria-expanded="false"] { box-shadow: none }': NO_PARTS_YET,
  },
  'form/slider': {
    '[data-block="form_slider"] .form-slider-value { margin-left: 0.4rem }': 'the space between the label and its inline value is horizontal; a style sets vertical space only (space_before, space_after), and the value part\'s padding adds to it',
  },
  'template/page_author': {
    '[data-block="page-author"] { gap: 0.5rem }': NO_PARTS_YET,
    '[data-block="page-author"] { font-size: 0.875rem }': NO_PARTS_YET,
    '[data-block="page-author"] .block-author-avatar { border-radius: 50% }': NO_PARTS_YET,
  },
  'template/page_breadcrumbs': {
    '[data-block="breadcrumbs"] { font-size: 0.875rem }': NO_PARTS_YET,
    '[data-block="breadcrumbs"][data-divider="true"] { border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent) }': NO_PARTS_YET,
    '[data-block="breadcrumbs"] li:not(:last-child)::after { margin-inline: 0.35rem }': NO_PARTS_YET,
    '[data-block="breadcrumbs"] li:not(:last-child)::after { opacity: 0.55 }': NO_PARTS_YET,
    '[data-block="breadcrumbs"] a { text-underline-offset: 0.15em }': NO_PARTS_YET,
    '[data-block="breadcrumbs"] [aria-current="page"] { font-weight: 600 }': NO_PARTS_YET,
  },
  'template/page_date': {
    '[data-block="page-date"] { font-size: 0.875rem }': NO_PARTS_YET,
    '[data-block="page-date"] { opacity: 0.7 }': NO_PARTS_YET,
  },
  'template/page_navigation': {
    '[data-block="page_navigation"] { gap: 1rem }': NO_PARTS_YET,
    '[data-block="page_navigation"] a { padding: 0.85rem 1rem }': NO_PARTS_YET,
    '[data-block="page_navigation"] a { border: 1px solid color-mix(in srgb, currentColor 16%, transparent) }': NO_PARTS_YET,
    '[data-block="page_navigation"] a { border-radius: 0.5rem }': NO_PARTS_YET,
    '[data-block="page_navigation"] a { text-decoration: none }': NO_PARTS_YET,
  },
  'template/site_logo': {
    '[data-block="site-logo"] { font-weight: 600 }': NO_PARTS_YET,
    '[data-block="site-logo"] { text-decoration: none }': NO_PARTS_YET,
  },
};
