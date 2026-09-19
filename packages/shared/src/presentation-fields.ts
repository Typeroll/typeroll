import type { FieldDefinition } from './types.js';
export const pixels = (name: string, label: string, min = 0, max = 2400): FieldDefinition => ({
  name, label, type: 'number', min, max, responsive: true, css_unit: 'px',
});
export const typographyFields: FieldDefinition[] = [
  pixels('font_size_px', 'Text size (px)', 12, 160),
  { name: 'line_height', label: 'Line height', type: 'number', min: 1, max: 2.5, responsive: true, css_unit: 'number' },
];
