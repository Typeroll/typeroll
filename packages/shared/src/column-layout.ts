/** Columns own the narrow-layout boundary; their outline follows that boundary. */
export const COLUMN_STACK_BELOW = ['721', '768', '1024', '1280'];

export const COLUMN_STACK_CSS = COLUMN_STACK_BELOW.map(value => {
  const columns = `[data-block="columns"][data-stack-below="${value}"]`;
  const slot = `${columns} > .block-columns-col`;
  const toc = '[data-block="table_of_contents"]';
  // A responsive block may have an adjacent generated style element. Only
  // actual visible content prevents the otherwise empty outline slot hiding.
  const outlineOnly = `${slot}:has(> ${toc}[data-mobile-display="hidden"]):not(:has(> :not(${toc},style,script)))`;
  return `@media (max-width:${Number(value) - 1}px) {
${columns} { grid-template-columns:minmax(0,1fr); }
${columns}[data-mobile-order="right-first"] > .block-columns-col:last-child { order:-1; }
${slot} > ${toc}, ${slot}:has(> ${toc}) { position:static; max-height:none; }
${slot} > ${toc}[data-mobile-display="hidden"], ${outlineOnly} { display:none; }
}`;
}).join('\n');

export const EMPTY_OUTLINE_COLUMN_CSS = `
[data-block="columns"]:has(> .block-columns-col:last-child > [data-block="table_of_contents"][data-empty="true"]):not(:has(> .block-columns-col:last-child > :not([data-block="table_of_contents"],style,script))) { grid-template-columns:minmax(0,1fr); }
[data-block="columns"] > .block-columns-col:has(> [data-block="table_of_contents"][data-empty="true"]):not(:has(> :not([data-block="table_of_contents"],style,script))) { display:none; }
`;
