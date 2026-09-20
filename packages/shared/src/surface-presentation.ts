import type { FieldDefinition } from './types.js';

/** Two fixed stops keep the native control simple and leave solid defaults alone. */
export const backgroundGradientField: FieldDefinition = {
  name: 'background_gradient', type: 'object', label: 'Linear gradient (optional)', editor_group: 'appearance',
  fields: [
    { name: 'from', type: 'color', label: 'Start color', required: true },
    { name: 'to', type: 'color', label: 'End color', required: true },
    { name: 'angle', type: 'number', label: 'Angle (degrees)', min: 0, max: 360, default: 135 },
  ],
};

// Data may arrive directly from API clients. Never interpolate CSS declarations,
// URLs, or arbitrary functions into a generated background image.
export function surfaceColor(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) return '';
  const text = value.trim();
  return /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/deg]+\)|var\(--[\w-]+(?:\s*,\s*(?:#[\da-f]{3,8}|[a-z]+))?\))$/i.test(text) ? text : '';
}

export function surfaceGradientCss(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const { from, to, angle = 135 } = value as Record<string, unknown>;
  const start = surfaceColor(from), end = surfaceColor(to);
  if (!start || !end || typeof angle !== 'number' || !Number.isFinite(angle) || angle < 0 || angle > 360) return '';
  return `--surface-gradient:linear-gradient(${angle}deg,${start} 0%,${end} 100%);`;
}
