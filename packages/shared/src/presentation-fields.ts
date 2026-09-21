import type { FieldDefinition } from './types.js';
export const pixels = (name: string, label: string, min = 0, max = 2400): FieldDefinition => ({
  name, label, type: 'number', min, max, responsive: true, css_unit: 'px',
});
export const typographyFields: FieldDefinition[] = [
  pixels('font_size_px', 'Text size (px)', 12, 160),
  { name: 'line_height', label: 'Line height', type: 'number', min: 1, max: 2.5, responsive: true, css_unit: 'number' },
];

/** A complete, local map overrides only this component, never siblings/children. */
export const componentBreakpointsField: FieldDefinition = {
  name: 'responsive_breakpoints', type: 'object', label: 'Block viewport widths (optional)',
  fields: Object.entries({ tablet: 640, laptop: 1024, desktop: 1280, wide: 1536 }).map(([name, value]) => ({
    name, label: `${name} starts at (px)`, type: 'number', min: 320, max: 2560, default: value,
  })),
};

export const postCardImageSizing: Record<string, string> = {
  auto: '--card-image-position:static;--card-image-height:var(--image_height_px,auto);',
  intrinsic: '--card-image-position:static;--card-image-height:auto;',
  fixed: '--card-image-position:static;--card-image-height:var(--image_height_px,200px);',
  stretch: '--card-image-position:absolute;--card-image-height:100%;',
};

/** Registry metadata also keeps API/MCP clients aligned with the native inspector. */
export function groupPresentationField(field: FieldDefinition): FieldDefinition {
  if (field.editor_group || field.required) return field;
  const advanced = field.css_unit || ['responsive_breakpoints','inline_style','css_class','html_id','attributes','anchor_id','stack_below_px'].includes(field.name);
  const appearance = field.responsive || field.type === 'color' || ['font_weight','width','max_width','appearance','shadow','overflow','radius','size','font','image_fit','fit','image_aspect','aspect_ratio','title_font','image_sizing','download_style','download_behavior','panel_padding','collapse_below','rhythm'].includes(field.name);
  return { ...field, editor_group: advanced ? 'advanced' : appearance ? 'appearance' : 'content' };
}

/** Optional shared body heading scale. Individual heading sizes still win. */
export const articleHeadingFields: FieldDefinition[] = [
  ...[1,2,3,4,5,6].map(level => pixels(`h${level}_size_px`, `Body H${level} size (px)`, 12, 160)),
  pixels('heading_before_px', 'Body heading space before (px)', 0, 240),
  pixels('heading_after_px', 'Body heading space after (px)', 0, 120),
];
export const focalPointFields: FieldDefinition[] = ['x','y'].map(axis => ({
  name: `focal_${axis}`, label: `Image focal ${axis === 'x' ? 'horizontal' : 'vertical'} position (%)`,
  type: 'number', min: 0, max: 100, default: 50, css_unit: 'number', responsive: true,
}));
