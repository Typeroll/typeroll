/** Shared geometry for static output and editor preview. Full-bleed sections
 * own their gutter; semantic sections such as field lists are ordinary content. */
export const CONTENT_WELL_CSS = `
:root { --content-gutter:1.25rem; }
@media (min-width:768px) { :root { --content-gutter:1.75rem; } }
.page-content { max-width:var(--container-medium); margin:0 auto; padding:var(--spacing-lg) var(--content-gutter); }
.page-content--blocks { max-width:none; padding:0; }
.page-content--blocks > * + * { margin-top:0; }
.page-content--blocks > :not([data-block="section"],style,script) {
  box-sizing:border-box; max-width:var(--container-medium); margin-inline:auto; padding-inline:var(--content-gutter);
}
.page-content--blocks > :not([data-block="section"],style,script) + :not([data-block="section"],style,script) { margin-top:var(--spacing-md); }
`.trim();
