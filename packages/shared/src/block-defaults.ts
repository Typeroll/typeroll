/**
 * Block defaults that hold for every block type from render version 14. They
 * live in the blocks layer, after each type's own styles, with zero
 * specificity where they set a default a block may change.
 * See docs/plans/responsive-defaults-and-cascade.md.
 */
export const BLOCK_DEFAULTS_V14_CSS = `
/* A word longer than its column wraps instead of widening the page. */
:where([data-block]) { overflow-wrap:anywhere; }
/* Media never grows wider than the block it sits in. */
:where([data-block]) :where(img,video,iframe,canvas) { max-inline-size:100%; }
:where([data-block]) :where(img) { block-size:auto; }
/* Flex and grid children can shrink below their longest word, and nothing
   inside a block grows wider than its parent (tables and code scroll instead). */
:where([data-block], [data-block] *) { min-width:0; }
/* Icons keep their size in a row; the text beside them gives way. */
:where([data-block]) :where([class$="-icon"], [class*="-icon "], svg) { flex-shrink:0; }
:where([data-block] *):not(:where(table,thead,tbody,tfoot,tr,td,th,pre,code,pre *)) { max-inline-size:100%; }
/* Text blocks: the first and last element sit flush with the block, so spacing comes from the layout. */
[data-block="prose"] > :first-child { margin-block-start:0; }
[data-block="prose"] > :last-child { margin-block-end:0; }
/* Containers and grids space their children with gap; children add no margin of their own. */
:is([data-block="container"],[data-block="grid"],[data-block="columns"],[data-block="semantic-container"]:not([data-rhythm="article"])) > [data-block] { margin-block:0; }
/* Grids of repeated items: the column setting is the maximum, and each item keeps a minimum
   width, so a grid in a narrow column or on a phone has fewer columns instead of slivers. */
[data-block="repeater"][data-layout="grid"] { --min-item:10rem; }
[data-block="repeater"][data-layout="grid"]:has(> [data-block="logo_item"]) { --min-item:5rem; }
[data-block="repeater"][data-layout="grid"]:has(> :is([data-block="icon_box"],[data-block="pricing_plan"],[data-block="team_member"],[data-block="testimonial"],[data-block="post_card"],[data-block="step_card"],[data-block="media_card"])) { --min-item:14rem; }
[data-block="repeater"][data-layout="grid"][data-layout] { grid-template-columns:repeat(auto-fill, minmax(min(100%, max(var(--min-item), (100% - (var(--cols, 3) - 1) * var(--gap_px, var(--rep-gap, 1rem))) / var(--cols, 3))), 1fr)); }
/* The Grid block: its column count is the maximum, and a cell keeps at least 8rem, so a grid
   inside a narrow column has fewer, usable columns. Stacking settings still apply first. */
[data-block="grid"]:not([data-last-row="center"]) { grid-template-columns:repeat(auto-fill, minmax(min(100%, max(8rem, (100% - (var(--cols, 3) - 1) * var(--gap_px, var(--container-gap, 1rem))) / var(--cols, 3))), 1fr)); }
/* A constrained container in a section starts where the text beside it starts, instead of centring on its own. */
.block-section-inner > [data-block="container"]:is([data-width="narrow"],[data-width="normal"],[data-width="wide"]) { margin-inline:0 auto; }
/* A testimonial's author keeps a readable column: the avatar never shrinks and the company logo moves below when space runs out. */
[data-block="testimonial"] .block-testimonial-cite { flex-wrap:wrap; }
[data-block="testimonial"] .block-testimonial-avatar { flex:none; }
[data-block="testimonial"] .block-testimonial-meta { flex:1 1 10rem; }
/* Centred heroes centre their buttons too. */
[data-block="hero"][style*="--layout:centered"] .block-hero-actions,
[data-block="hero"][style*="--hero-text-align:center"] .block-hero-actions { justify-content:center; }
/* Two-column rows: each column keeps its maximum width without leaving its grid track. */
[data-block="feature_row"] .block-frow-body { max-width:min(34rem, 100%); }
/* A card title link stays a comfortable target even when it holds only an icon. */
[data-block="post_card"] .block-postcard-title > a { min-block-size:24px; }
/* Touch targets of at least 24 × 24 px (WCAG 2.2 AA) for links that stand alone. */
[data-block="icon"] .block-icon-link { display:inline-flex; align-items:center; justify-content:center; min-inline-size:24px; min-block-size:24px; }
[data-block="team_member"] .block-team-socials a { display:inline-flex; align-items:center; min-block-size:24px; }
[data-block="breadcrumbs"] a { display:inline-block; padding-block:.25rem; }
/* A call to action without a chosen background uses the theme's primary colour, so its text stays readable. */
[data-block="cta"][style*="--bg:;"], [data-block="cta"]:not([style*="--bg:"]) { background-color:var(--color-primary,#111); }
/* Headings in a call to action take the block's text colour, which is chosen for its background. */
[data-block="cta"] :is(h1,h2,h3,h4,h5,h6) { color:inherit; }
/* Pill buttons keep pill ends on one line and become rounded rectangles when their label wraps. */
:is([data-block="cta"],[data-block="hero"],[data-block="feature_row"]) .block-btn { border-radius:1.6rem; }
/* A step marker is a circle for a number and grows with a label: wider first, then taller, wrapping between words. */
[data-block="step_card"] .block-step-number { display:inline-block; box-sizing:border-box; inline-size:auto; block-size:auto; min-inline-size:2.5rem; padding:.3rem .65rem; line-height:1.9rem; border-radius:1.25rem; text-align:center; overflow-wrap:break-word; hyphens:auto; }
/* Button labels hyphenate a word that does not fit rather than breaking it at an arbitrary letter. */
:is([data-block="button"], .block-btn, .block-pricing-cta, button) { hyphens:auto; }
/* Phones get compact padding; desktops keep the previous space. */
[data-block="cta"] { padding:clamp(2rem, 1rem + 4vw, 4rem) clamp(1.25rem, 1rem + 1vw, 1.5rem); }
[data-block="feature_row"], [data-block="feature_row"][style*="--padding_y:lg"] { --block-py:clamp(2rem, 1rem + 4vw, 4rem); }
[data-block="feature_row"][style*="--padding_y:md"] { --block-py:clamp(1.5rem, .75rem + 3vw, 3rem); }
[data-block="feature_row"][style*="--padding_y:xl"] { --block-py:clamp(2.5rem, .5rem + 7vw, 6rem); }
@media (max-width: 767px) { [data-block="feature_row"] .block-frow-inner { gap:var(--space-md,1rem); } }
/* Carousels show one card and a glimpse of the next on narrow screens. */
[data-block="repeater"][data-layout="carousel"] { container-type:inline-size; }
@container (max-width: 560px) {
  [data-block="repeater"][data-layout="carousel"] > .tr-carousel-track > * { flex-basis:85%; }
}
`.trim();
