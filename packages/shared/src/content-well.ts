/** Shared geometry for static output and editor preview. Full-bleed sections
 * own their gutter; semantic sections such as field lists are ordinary content. */
export const CONTENT_WELL_CSS = `
:root {
 --space-1:.25rem; --space-2:.5rem; --space-3:.75rem; --space-4:1rem;
 --space-5:1.5rem; --space-6:2rem; --space-7:2.5rem; --space-8:3rem;
 --space-9:4rem; --space-10:5rem; --space-11:6rem; --space-12:8rem;
 --content-gutter:1.25rem; --section-padding:var(--space-8);
 --block-gap:var(--space-5); --block-gap-tight:var(--space-3); --block-gap-loose:var(--space-6);
 --card-padding:var(--space-4); --grid-gap:var(--space-4);
 --type-h1:1.75rem; --type-h2:1.375rem; --type-h3:1.125rem; --type-h4:1rem; --type-h5:1rem; --type-h6:.875rem;
 --type-lead:1.0625rem; --body-leading:1.55;
 --breadcrumbs-before:.75rem; --breadcrumbs-after:2rem;
}
@media (min-width:768px) { :root { --content-gutter:1.75rem; --section-padding:var(--space-9); --card-padding:var(--space-5); --grid-gap:var(--space-5); --type-h1:2rem; --type-h2:1.5rem; --type-h3:1.25rem; --type-h4:1.0625rem; --type-lead:1.125rem; } }
@media (min-width:1024px) { :root { --breadcrumbs-before:1rem; --breadcrumbs-after:2.5rem; } }
@media (min-width:1280px) { :root { --section-padding:var(--space-10); --block-gap:var(--space-6); --block-gap-loose:var(--space-7); --type-h1:2.25rem; --type-h4:1.125rem; } }
.page-content { max-width:var(--container-medium); margin:0 auto; padding:var(--spacing-lg) var(--content-gutter); }
.page-content--blocks { max-width:none; padding:0; }
.page-content--blocks > * + * { margin-top:0; }
.page-content--blocks > :not([data-block="section"],[data-block="hero"],[data-block="container"][data-width="full"],[data-block="semantic-container"][data-width="full"],style,script) {
  box-sizing:border-box; max-width:var(--container-medium); margin-inline:auto; padding-inline:var(--content-gutter);
}
.page-content--blocks > :not([data-block="section"],[data-block="hero"],[data-block="container"][data-width="full"],[data-block="semantic-container"][data-width="full"],style,script) + :not([data-block="section"],[data-block="hero"],[data-block="container"][data-width="full"],[data-block="semantic-container"][data-width="full"],style,script) { margin-top:var(--block-gap); }
/* Low-specificity defaults let block settings and site styles win. */
:where(.page-content) { line-height:var(--body-leading); }
:where(.page-content) :is(h1,h2,h3,h4,h5,h6) { font-weight:600; overflow-wrap:anywhere; }
:where(.page-content) h1 { font-size:var(--type-h1); line-height:1.2; }
:where(.page-content) h2 { font-size:var(--type-h2); line-height:1.25; }
:where(.page-content) h3 { font-size:var(--type-h3); line-height:1.3; }
:where(.page-content) h4 { font-size:var(--type-h4); line-height:1.35; }
:where(.page-content) h5 { font-size:var(--type-h5); line-height:1.4; }
:where(.page-content) h6 { font-size:var(--type-h6); line-height:1.4; }
.page-content .block-section-inner { --section-child-gap:var(--content_gap_px,var(--block-gap)); }
.page-content .block-section-inner > * + * { margin-block-start:var(--section-child-gap,var(--block-gap)); }
.page-content .block-section-inner > :first-child { margin-block-start:0; }
.page-content .block-section-inner > :last-child { margin-block-end:0; }
.page-content .block-section-inner > [data-block="breadcrumbs"] + * { margin-block-start:0; }
`.trim();
