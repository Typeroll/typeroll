/**
 * Block defaults from render version 14. They live in the blocks layer,
 * after each type's own styles. General rules apply to every block and use
 * zero specificity where they set a default a block may change; type rules
 * are emitted only for the block types a page uses.
 * See docs/plans/responsive-defaults-and-cascade.md.
 */
export const BLOCK_DEFAULTS_V14_CSS = `
/* A word longer than its column wraps instead of widening the page. */
:where([data-block]) { overflow-wrap:anywhere; }
/* An image without a source (an optional logo or avatar) takes no space. */
:where([data-block]) :is(img:not([src]), img[src=""]) { display:none; }
/* Media never grows wider than the block it sits in. */
:where([data-block]) :where(img,video,iframe,canvas) { max-inline-size:100%; }
:where([data-block]) :where(img) { block-size:auto; }
/* An image in a block sits where the block places it; only running text adds space around its images. */
:where([data-block]:not([data-block="prose"])) :where(img) { margin-block:0; }
/* Flex and grid children can shrink below their longest word, and nothing
   inside a block grows wider than its parent (tables and code scroll instead). */
:where([data-block], [data-block] *) { min-width:0; }
:where([data-block] *):not(:where(table,thead,tbody,tfoot,tr,td,th,pre,code,pre *,[data-block="prose"])) { max-inline-size:100%; }
/* Running text keeps its reading measure and never grows wider than its column. */
:where([data-block="prose"]) { max-inline-size:min(100%, var(--measure-prose, 65ch)); }
/* Icons keep their size in a row; the text beside them gives way. */
:where([data-block]) :where([class$="-icon"], [class*="-icon "], svg) { flex-shrink:0; }
/* Button labels hyphenate a word that does not fit rather than breaking it at an arbitrary letter. */
:where(.block-btn, .block-pricing-cta, button) { hyphens:auto; }
/* Headings balance their lines, so a title does not end with one word alone. */
:where(h1,h2,h3,h4) { text-wrap:balance; }
/* Grid cells, columns and tab panels are containers: blocks inside them adapt to the cell, not the screen. */
:where([data-block="grid"] > *, [data-block="repeater"][data-layout="grid"] > *, .block-columns-col, .block-tabs-panel) { container-type:inline-size; }
`.trim();

const CONTAINER_CHILDREN = (selector: string) => `/* Containers and grids space their children with gap; children add no margin of their own. */
${selector} > [data-block] { margin-block:0; }`;

/** Per block type, keyed by type id. */
export const BLOCK_TYPE_DEFAULTS_V14: Readonly<Record<string, string>> = {
  'core/section': `/* A shape divider fills the space between sections; it never covers the content of the block next to it. */
[data-block="section"]:is([data-divtop="wave"],[data-divtop="curve"],[data-divtop="tilt"]) { margin-block-start:clamp(34px, 6vw, 80px); }
[data-block="section"]:is([data-divbot="wave"],[data-divbot="curve"],[data-divbot="tilt"]) { margin-block-end:clamp(34px, 6vw, 80px); }
/* A section inside a column, grid cell, tab or container groups content; without its own background it adds no padding. */
:is(.block-columns-col, [data-block="grid"], .block-tabs-panel, [data-block="container"], [data-block="semantic-container"]) > [data-block="section"][style*="--block-bg:;"]:not([style*="--surface"]) { padding:0; }
/* Content widths come from the shared narrow, normal and wide widths. */
[data-block="section"] > .block-section-inner { max-width:var(--max_width_px, var(--content-normal, 65rem)); }
[data-block="section"][data-width="narrow"] > .block-section-inner { max-width:var(--max_width_px, var(--content-narrow, 42rem)); }
[data-block="section"][data-width="wide"] > .block-section-inner { max-width:var(--max_width_px, var(--content-wide, 80rem)); }`,
  'core/prose': `/* Text blocks: the first and last element sit flush with the block, so spacing comes from the layout. */
[data-block="prose"] > :first-child { margin-block-start:0; }
[data-block="prose"] > :last-child { margin-block-end:0; }`,
  'core/container': `/* A container without padding settings has none: it groups and lays out, the blocks around it space it. */
:where([data-block="container"]) { --block-px:0; --block-py:0; }
${CONTAINER_CHILDREN(':is([data-block="container"],[data-block="semantic-container"]:not([data-rhythm="article"]))')}
/* A constrained container in a section, column, tab or grid cell starts where the text beside it starts and fills
   the space up to its maximum width, instead of centring and shrinking to its content. */
:is(.block-section-inner, .block-columns-col, .block-tabs-panel, [data-block="grid"]) > [data-block="container"]:is([data-width="narrow"],[data-width="normal"],[data-width="wide"]) { margin-inline:0; inline-size:100%; }
/* Content widths come from the shared narrow, normal and wide widths. */
[data-block="container"][data-width="narrow"] { max-width:var(--max_width_px, var(--content-narrow, 42rem)); }
[data-block="container"][data-width="normal"] { max-width:var(--max_width_px, var(--content-normal, 65rem)); }
[data-block="container"][data-width="wide"] { max-width:var(--max_width_px, var(--content-wide, 80rem)); }`,
  'core/columns': CONTAINER_CHILDREN('[data-block="columns"]'),
  'core/grid': `${CONTAINER_CHILDREN('[data-block="grid"]')}
/* The column count is the maximum, and a cell keeps at least 10rem, so a grid inside a narrow
   column has fewer, usable columns. Stacking settings still apply first. */
[data-block="grid"]:not([data-last-row="center"]) { grid-template-columns:repeat(auto-fill, minmax(min(100%, max(10rem, (100% - (var(--cols, 3) - 1) * var(--gap_px, var(--container-gap, 1rem))) / var(--cols, 3))), 1fr)); }`,
  'core/repeater': `/* Grids of repeated items: the column setting is the maximum, and each item keeps a minimum
   width, so a grid in a narrow column or on a phone has fewer columns instead of slivers. */
[data-block="repeater"][data-layout="grid"] { --min-item:10rem; }
/* An empty-state message spans the whole grid instead of filling the first cells. */
[data-block="repeater"][data-layout="grid"] > :is(p,ul,ol,div:not([data-block])) { grid-column:1 / -1; }
[data-block="repeater"][data-layout="grid"]:has(> [data-block="logo_item"]) { --min-item:7rem; row-gap:var(--space-md, 1rem); }
[data-block="repeater"][data-layout="grid"]:has(> :is([data-block="icon_box"],[data-block="pricing_plan"],[data-block="team_member"],[data-block="testimonial"],[data-block="post_card"],[data-block="step_card"],[data-block="media_card"])) { --min-item:14rem; }
/* Fewer items than columns share the row instead of leaving empty columns. */
[data-block="repeater"][data-layout="grid"][data-layout] { grid-template-columns:repeat(auto-fit, minmax(min(100%, max(var(--min-item), (100% - (var(--cols, 3) - 1) * var(--gap_px, var(--rep-gap, 1rem))) / var(--cols, 3))), 1fr)); }
/* Carousels show one card and a glimpse of the next on narrow screens. */
[data-block="repeater"][data-layout="carousel"] { container-type:inline-size; }
@container (max-width: 560px) {
  [data-block="repeater"][data-layout="carousel"] > .tr-carousel-track > * { flex-basis:85%; }
}`,
  'core/testimonial': `/* The author keeps a readable column: the avatar never shrinks and the company logo moves below when space runs out. */
[data-block="testimonial"] .block-testimonial-cite { flex-wrap:wrap; }
[data-block="testimonial"] .block-testimonial-avatar { flex:none; }
[data-block="testimonial"] .block-testimonial-meta { flex:1 1 10rem; }
/* The avatar sits beside the name, and the company logo is readable. */
[data-block="testimonial"] .block-testimonial-cite { align-items:flex-start; }
[data-block="testimonial"] .block-testimonial-logo { max-height:2rem; min-width:3rem; opacity:.8; align-self:center; }`,
  'core/hero': `/* Centred heroes centre their buttons too. */
[data-block="hero"][style*="--layout:centered"] .block-hero-actions,
[data-block="hero"][style*="--hero-text-align:center"] .block-hero-actions { justify-content:center; }
/* Pill buttons keep pill ends on one line and become rounded rectangles when their label wraps. */
[data-block="hero"] .block-btn { border-radius:1.6rem; }
/* The heading scales with the hero, so a hero in a narrow column keeps whole words on a line. */
[data-block="hero"] { container-type:inline-size; }
[data-block="hero"] .block-hero-heading { font-size:min(var(--type-h1, 1.75rem), max(1.5rem, 9cqi)); }
/* Inside a column, grid cell, tab or container the hero keeps compact padding: the block around it spaces it. */
:is(.block-columns-col, [data-block="grid"], .block-tabs-panel, [data-block="container"], [data-block="semantic-container"]) > [data-block="hero"] { padding:clamp(1.25rem, 4cqi, 2.5rem); }
/* The hero's content lines up with sections of the same width. */
[data-block="hero"] .block-hero-inner { max-width:var(--content-normal, 65rem); }
[data-block="hero"][data-width="narrow"] .block-hero-inner { max-width:var(--content-narrow, 42rem); }
[data-block="hero"][data-width="wide"] .block-hero-inner { max-width:var(--content-wide, 80rem); }`,
  'core/feature_row': `/* Each column keeps its maximum width without leaving its grid track. */
[data-block="feature_row"] .block-frow-body { max-width:min(34rem, 100%); }
/* Phones get compact padding; desktops keep the previous space. */
[data-block="feature_row"], [data-block="feature_row"][style*="--padding_y:lg"] { --block-py:clamp(2rem, 1rem + 4vw, 4rem); }
[data-block="feature_row"][style*="--padding_y:md"] { --block-py:clamp(1.5rem, .75rem + 3vw, 3rem); }
[data-block="feature_row"][style*="--padding_y:xl"] { --block-py:clamp(2.5rem, .5rem + 7vw, 6rem); }
@media (max-width: 767px) { [data-block="feature_row"] .block-frow-inner { gap:var(--space-md,1rem); } }
/* Pill buttons keep pill ends on one line and become rounded rectangles when their label wraps. */
[data-block="feature_row"] .block-btn { border-radius:1.6rem; }
/* The row's content lines up with sections of the same width. */
[data-block="feature_row"] .block-frow-inner { max-width:var(--content-normal, 65rem); }
[data-block="feature_row"][data-width="wide"] .block-frow-inner { max-width:var(--content-wide, 80rem); }
/* In a wide row the default image and the text fill their columns, so they reach the same edges as a wide hero or section. */
[data-block="feature_row"][data-width="wide"][data-image-max="lg"] { --frow-img-max:100%; }
[data-block="feature_row"][data-width="wide"] .block-frow-body { max-width:100%; }
/* Inside a section, column or tab a row without its own background starts where the text beside it starts. */
:is(.block-section-inner, .block-columns-col, .block-tabs-panel) > [data-block="feature_row"][style$="--bg:"] { padding-inline:0; }
/* Inside a tab, column, grid cell or container the row drops its default outer padding: the block around it spaces it. */
:is(.block-tabs-panel, .block-columns-col, [data-block="grid"], [data-block="container"], [data-block="semantic-container"]) > [data-block="feature_row"][style*="--padding_y:lg"] { --block-py:0; }
:is(.block-tabs-panel, .block-columns-col, [data-block="grid"], [data-block="container"], [data-block="semantic-container"]) > [data-block="feature_row"][style$="--bg:"] { padding-inline:0; }
/* A row inside another block fills it: the block around it sets the width, so the row's edges match the content beside it. */
:is(.block-section-inner, .block-tabs-panel, .block-columns-col, [data-block="grid"], [data-block="container"], [data-block="semantic-container"]) > [data-block="feature_row"] .block-frow-inner { max-width:none; }
:is(.block-section-inner, .block-tabs-panel, .block-columns-col, [data-block="grid"], [data-block="container"], [data-block="semantic-container"]) > [data-block="feature_row"][data-image-max="lg"] { --frow-img-max:100%; }
:is(.block-section-inner, .block-tabs-panel, .block-columns-col, [data-block="grid"], [data-block="container"], [data-block="semantic-container"]) > [data-block="feature_row"] .block-frow-body { max-width:100%; }
/* The row stacks by its own width, so it also stacks in a narrow column or grid cell on a wide screen. */
[data-block="feature_row"] { container-type:inline-size; }
/* The heading scales with the row, not the screen. */
[data-block="feature_row"] .block-frow-heading { font-size:clamp(1.375rem, 1rem + 2.5cqi, 2.25rem); }
@container (max-width: 42rem) {
  [data-block="feature_row"] .block-frow-inner { grid-template-columns: 1fr; gap: var(--space-md, 1rem); }
  [data-block="feature_row"] .block-frow-media,
  [data-block="feature_row"][data-image-side="right"] .block-frow-media { order: 1; }
  [data-block="feature_row"] .block-frow-body,
  [data-block="feature_row"][data-image-side="right"] .block-frow-body { order: 2; margin-inline: 0; max-width: none; }
  [data-block="feature_row"] .block-frow-media img,
  [data-block="feature_row"][data-image-side="right"] .block-frow-media img { margin-inline: auto; }
  [data-block="feature_row"][data-stack-order="text-first"] .block-frow-media { order: 2; }
  [data-block="feature_row"][data-stack-order="text-first"] .block-frow-body { order: 1; }
}`,
  'core/post_card': `/* A card title link stays a comfortable target even when it holds only an icon. */
/* A title icon sits on the first line of a title that wraps. */
[data-block="post_card"] .block-postcard-title:has(.block-postcard-title-icon) > a { align-items:flex-start; }
[data-block="post_card"] .block-postcard-title-icon { margin-block-start:calc((1lh - 1em) / 2); }
/* A card image never fills a whole screen: on a wide card it is cropped to a comfortable height. */
[data-block="post_card"] .block-postcard-media img { max-block-size:min(26rem, 70vh); object-fit:cover; }
[data-block="post_card"] .block-postcard-title > a { display:inline-block; min-block-size:24px; }`,
  'core/table_of_contents': `/* Links in the outline are touch targets of at least 24px. */
[data-block="table_of_contents"] a { display:inline-block; padding-block:.15rem; }
/* An outline with no headings to list takes no space. */
[data-block="table_of_contents"][data-empty="true"] { display:none; }
/* A nested level is a plain list, so its numbers do not look like they continue the level above. */
[data-block="table_of_contents"] :is(ol,ul) :is(ol,ul) { list-style:disc; }`,
  'core/icon': `/* A linked icon is a touch target of at least 24 × 24 px (WCAG 2.2 AA). */
[data-block="icon"] .block-icon-link { display:inline-flex; align-items:center; justify-content:center; min-inline-size:24px; min-block-size:24px; }`,
  'core/team_member': `/* A photo in a one-column layout stays portrait-sized instead of filling a phone screen. */
[data-block="team_member"] .block-team-photo, [data-block="team_member"] img { max-inline-size:min(100%, 16rem); margin-inline:auto; }
/* Social links are touch targets of at least 24px. */
[data-block="team_member"] .block-team-socials a { display:inline-flex; align-items:center; min-block-size:24px; }`,
  'template/page_breadcrumbs': `/* Breadcrumb links are touch targets of at least 24px. */
[data-block="breadcrumbs"] a { display:inline-block; padding-block:.25rem; }`,
  'core/cta': `/* Without a chosen background a call to action uses the theme's primary colour, so its text stays readable. */
[data-block="cta"][style*="--bg:;"], [data-block="cta"]:not([style*="--bg:"]) { background-color:var(--color-primary,#111); }
/* Headings take the block's text colour, which is chosen for its background. */
[data-block="cta"] :is(h1,h2,h3,h4,h5,h6) { color:inherit; }
/* Phones get compact padding; desktops keep the previous space. */
[data-block="cta"] { padding:clamp(2rem, 1rem + 4vw, 4rem) clamp(1.25rem, 1rem + 1vw, 1.5rem); }
/* Pill buttons keep pill ends on one line and become rounded rectangles when their label wraps. */
[data-block="cta"] .block-btn { border-radius:1.6rem; }
/* The heading scales with the call to action, so a narrow one keeps whole words on a line. */
[data-block="cta"] { container-type:inline-size; }
[data-block="cta"] .block-cta-heading { font-size:clamp(1.25rem, .75rem + 3.5cqi, 2.5rem); }
/* Left-aligned text uses the full width of the band, so it lines up with sections of the same width. */
[data-block="cta"][style*="--align:left"] .block-cta-inner { max-width:none; }`,
  'core/logo_item': `/* A logo row is as tall as its logos. */
[data-block="logo_item"] { min-height:3rem; }`,
  'core/pricing_plan': `/* The period sits a space after the price. */
[data-block="pricing_plan"] .block-pricing-period:not(:empty) { margin-inline-start:.35em; }
/* A single plan on its own keeps the width of a plan card instead of stretching across the page. */
:is(.page-content--blocks, .block-section-inner, .block-tabs-panel, [data-block="container"]) > [data-block="pricing_plan"] { max-inline-size:26rem; }`,
  'core/table': `/* Table cells keep words whole (hyphenating a long one); a table wider than its column scrolls. */
[data-block="table"] :is(th,td) { overflow-wrap:normal; hyphens:auto; }
/* The caption wraps to the visible width and stays in view while a wide table scrolls. */
[data-block="table"] .block-table-scroll { container-type:inline-size; }
[data-block="table"] .block-table-scroll > table > caption { position:sticky; inset-inline-start:0; max-inline-size:100cqi; text-align:start; }`,
  'core/search': `/* In a column or a grid cell the search field starts where the content beside it starts. */
:is(.block-section-inner, .block-columns-col, .block-tabs-panel, [data-block="container"], [data-block="grid"]) > [data-block="search"] { margin-inline:0; padding-inline:0; }`,
  'core/step_card': `/* The step marker is a circle for a number and grows with a label: wider first, then taller, wrapping between words. */
[data-block="step_card"] .block-step-number { display:inline-block; box-sizing:border-box; inline-size:auto; block-size:auto; min-inline-size:2.5rem; max-inline-size:min(100%, 18rem); padding:.3rem .65rem; line-height:1.9rem; border-radius:1.25rem; text-align:center; overflow-wrap:break-word; hyphens:auto; }
/* A label that wraps stays a compact badge at text size, with its icon on the first line. */
[data-block="step_card"] .block-step-number { font-size:1rem; }
[data-block="step_card"] .block-step-marker { align-items:flex-start; }`,
  'core/button': `[data-block="button"] { hyphens:auto; }`,
  'core/heading': `/* The heading sits right under its eyebrow wherever the block is placed. */
[data-block="heading"] .block-heading-eyebrow + .block-heading-text:not(#\\#) { margin-block-start:0; }
/* A heading in a narrow column or grid cell scales down with it, so it keeps whole words on a line. */
[data-block="heading"]:not([data-size="theme"]) .block-heading-text { font-size:min(var(--heading-fs), max(1.25rem, 8cqi)); }`,
  'core/accordion': `/* The open-close mark keeps a gap from a title that wraps. */
[data-block="accordion"] summary { gap:1rem; }
[data-block="accordion"] summary::after { flex:none; }`,
  'core/media_card': `/* Pill buttons keep pill ends on one line and become rounded rectangles when their label wraps. */
[data-block="media_card"] .block-btn { border-radius:1.6rem; }
/* The card wraps when its text column would be narrower than 18rem, image above text, so it also
   stacks in a narrow column or grid cell. The text column takes the free space; the image keeps its width. */
@media (min-width: 721px) {
  [data-block="media_card"] { flex-wrap:wrap-reverse; }
  [data-block="media_card"] .block-mediacard-body { flex:999 1 18rem; }
  [data-block="media_card"] .block-mediacard-media { flex-grow:1; }
}`,
};

/**
 * Block defaults added in render version 16, per block type, after the
 * version 14 defaults. Older sites never get them.
 */
export const BLOCK_TYPE_DEFAULTS_V16: Record<string, string> = {
  'core/container': `/* An icon followed by content sits beside it, like a line of contact details, and the pairs are spaced apart so it is clear what belongs together. */
[data-block="container"][data-column-only="true"]:not([data-icon-pairing="off"]):has(> [data-block="icon"] + *) { display:grid; grid-template-columns:auto minmax(0, 1fr); column-gap:.75rem; row-gap:max(var(--gap_px, 1rem), 1.25rem); align-items:start; }
[data-block="container"][data-column-only="true"]:not([data-icon-pairing="off"]):has(> [data-block="icon"] + *) > * { grid-column:1 / -1; }
[data-block="container"][data-column-only="true"]:not([data-icon-pairing="off"]):has(> [data-block="icon"] + *) > [data-block="icon"]:has(+ *) { grid-column:1; }
[data-block="container"][data-column-only="true"]:not([data-icon-pairing="off"]):has(> [data-block="icon"] + *) > [data-block="icon"] + * { grid-column:2; margin-block:0; }`,
  'core/feature_row': `/* Feature rows that follow each other inside a section or column are clearly separate rows. */
:is(.block-section-inner, .block-columns-col, .block-tabs-panel, [data-block="container"], [data-block="semantic-container"]) > [data-block="feature_row"] + [data-block="feature_row"] { margin-block-start:clamp(2.5rem, 1.5rem + 4vw, 5rem); }
/* A row without its own background inside another block keeps its edges in line with the content beside it, also when it has spacing of its own. */
:is(.block-section-inner, .block-columns-col, .block-tabs-panel, [data-block="grid"], [data-block="container"], [data-block="semantic-container"]) > [data-block="feature_row"][style*="--bg:;"] { padding-inline:0; }`,
  'core/logo_item': `/* Logos wrap in centred rows: a short last row sits in the middle, and a phone fits three across.
   A logo grid set to last_row start keeps its grid. */
[data-block="repeater"][data-layout="grid"][data-layout]:not([data-last-row="start"]):has(> [data-block="logo_item"]) { display:flex; flex-wrap:wrap; justify-content:center; }
[data-block="repeater"][data-layout="grid"]:not([data-last-row="start"]):has(> [data-block="logo_item"]) > [data-block="logo_item"] { flex:0 1 calc((100% - (var(--cols, 6) - 1) * var(--gap_px, var(--rep-gap, 1rem))) / var(--cols, 6)); min-inline-size:min(100%, 5.5rem); }
/* A logo grid's logo height (logo_height_px) applies to logos without a height of their own. */
[data-block="repeater"] > [data-block="logo_item"]:not([data-height-px]) img { max-height:var(--logo-height, 3rem); }
[data-block="repeater"] > [data-block="logo_item"]:not([data-height-px]) { min-height:max(3rem, var(--logo-height, 0px)); }`,
  'core/navigation': `/* The collapsed menu is a button with a clearly visible menu symbol before its label, not a full-width field. */
[data-block="navigation"] .block-navigation-toggle { inline-size:auto; justify-content:flex-start; flex-direction:row-reverse; gap:.6rem; min-block-size:44px; padding:.55rem .9rem; border-radius:999px; }
[data-block="navigation"] .block-navigation-toggle-icon { font-size:0; inline-size:1.375rem; block-size:1rem; background:linear-gradient(currentColor, currentColor) top / 100% 2px no-repeat, linear-gradient(currentColor, currentColor) center / 100% 2px no-repeat, linear-gradient(currentColor, currentColor) bottom / 100% 2px no-repeat; }`,
  'core/navigation_form': `/* A form with a single field and no layout settings of its own is as wide as it needs to be, with its button to the right. */
[data-block="navigation_form"][data-compact="true"] { grid-template-columns:minmax(0, 1fr) auto; max-inline-size:var(--max_width_px, 32rem); }
[data-block="navigation_form"][data-compact="true"] .navigation-actions :is(a, button) { inline-size:auto; max-inline-size:16rem; }`,
};

