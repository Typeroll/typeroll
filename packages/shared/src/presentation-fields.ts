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
