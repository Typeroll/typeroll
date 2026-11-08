/** Columns own the narrow-layout boundary; their outline follows that boundary. */
export const COLUMN_STACK_BELOW = ['721', '768', '1024', '1280'];

/**
 * Stacking rules for columns below a width. Before render version 16 the
 * one-column rule is `!important`, which site CSS cannot beat inside a layer;
 * from 16 it relies on coming after the ratio and width rules instead.
 */
export function columnStackCss(value: number, columns: string, important = true): string {
  const slot = `${columns} > .block-columns-col`;
  const toc = '[data-block="table_of_contents"]';
  // A responsive block may have an adjacent generated style element. Only
  // actual visible content prevents the otherwise empty outline slot hiding.
  const outlineOnly = `${slot}:has(> ${toc}[data-mobile-display="hidden"]):not(:has(> :not(${toc},style,script)))`;
  return `@media (max-width:${Number(value) - 1}px) {
${columns} { grid-template-columns:minmax(0,1fr)${important ? ' !important' : ''}; }
${columns}[data-mobile-order="right-first"] > .block-columns-col:last-child { order:-1; }
${slot} > ${toc}, ${slot}:has(> ${toc}) { position:static; max-height:none; }
${slot} > ${toc}[data-mobile-display="hidden"], ${outlineOnly} { display:none; }
}`;
}

export const COLUMN_STACK_CSS = COLUMN_STACK_BELOW.map(value => columnStackCss(Number(value), `[data-block="columns"][data-stack-below="${value}"]`)).join('\n');

/** Render version 16: the same rules without `!important`; `never` keeps the columns side by side. */
export const COLUMN_STACK_CSS_V16 = COLUMN_STACK_BELOW.map(value => columnStackCss(Number(value), `[data-block="columns"][data-stack-below="${value}"]`, false)).join('\n');

export const EMPTY_OUTLINE_COLUMN_CSS = `
[data-block="columns"]:has(> .block-columns-col:last-child > [data-block="table_of_contents"][data-empty="true"]):not(:has(> .block-columns-col:last-child > :not([data-block="table_of_contents"],style,script))) { grid-template-columns:minmax(0,1fr); }
[data-block="columns"] > .block-columns-col:has(> [data-block="table_of_contents"][data-empty="true"]):not(:has(> :not([data-block="table_of_contents"],style,script))) { display:none; }
`;
