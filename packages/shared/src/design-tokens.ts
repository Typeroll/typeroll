import { designScalesError, typographyError } from './design-scale-validation.mjs';
export { designScalesError, typographyError, scaleLength } from './design-scale-validation.mjs';
import { BREAKPOINT_ORDER, resolveBreakpointWidths, type ResponsiveValue, type BreakpointWidths } from './breakpoints.js';
import type { FieldDefinition } from './types.js';

export const PALETTE_TOKENS = ['primary', 'secondary', 'accent', 'background', 'surface', 'surface_hover', 'text', 'text_light'] as const;
export const ON_COLOR_TOKENS = ['on_primary', 'on_secondary', 'on_accent'] as const;
export const COLOR_TOKENS = [...PALETTE_TOKENS, ...ON_COLOR_TOKENS] as const;
export const FONT_ROLES = ['heading', 'body', 'mono', 'inherit'] as const;
export const TOKEN_SCALES = {
  type_size: { xs: '0.75rem', sm: '0.875rem', md: '1rem', lg: '1.25rem', xl: '1.5rem', '2xl': '2rem', '3xl': '3rem' },
  space: { none: '0px', xs: '0.25rem', sm: '0.5rem', md: '1rem', lg: '1.5rem', xl: '3rem' },
  leading: { tight: '1.1', snug: '1.3', normal: '1.5', relaxed: '1.65', loose: '1.8' },
} as const;
export type TokenScale = keyof typeof TOKEN_SCALES;
export type DesignScales = Partial<Record<TokenScale, Record<string, ResponsiveValue<string>>>>;

export function tokenScale(field: FieldDefinition): TokenScale | undefined {
  if (field.design_token) return field.design_token;
  if (field.type !== 'number' || !field.css_unit) return undefined;
  if (/(?:^|_)line_height$/.test(field.name)) return 'leading';
  if (/(?:^|_)(?:font_size(?:_px)?|(?:h[1-6]|title|action|download|excerpt|meta|label)_size_px)$/.test(field.name)) return 'type_size';
  if (field.css_unit === 'px' && /(?:padding|margin|gap|spac(?:e|ing)|heading_(?:before|after))/.test(field.name)) return 'space';
  return undefined;
}
export function scaleValue(scale: TokenScale, value: unknown): string | undefined {
  return typeof value === 'string' && Object.hasOwn(TOKEN_SCALES[scale], value)
    ? `var(--${scale.replace('_', '-')}-${value})` : undefined;
}
export function scaleCss(scale: TokenScale, value: string): string {
  return scaleValue(scale, value) ?? value;
}
export function spacingCss(value: string): string {
  return value.split(/\s+/).map(part => scaleCss('space', part)).join(' ');
}
const HEX = /^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i;
const RGB = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]+\)$/i;
const COLOR_VAR = /^var\(--color-[a-z][a-z0-9-]*(?:,\s*(?:#[a-f0-9]{3,8}|transparent|currentColor))?\)$/i;
/** A restricted colour expression grammar; never accepts declarations or URLs. */
export function validColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if ((COLOR_TOKENS as readonly string[]).includes(value) || HEX.test(value) || COLOR_VAR.test(value)) return true;
  if (RGB.test(value)) {
    const channels = value.slice(value.indexOf('(') + 1, -1).trim().split(/[\s,/]+/);
    return [3, 4].includes(channels.length) && channels.every(channel => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(channel));
  }
  if (['transparent', 'inherit', 'currentColor', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'gray', 'grey', 'orange', 'purple', 'navy', 'teal', 'lime', 'silver', 'maroon', 'olive', 'aqua', 'fuchsia'].includes(value)) return true;
  const mix = value.match(/^color-mix\(in (?:srgb|oklab|oklch),\s*(.+)\)$/);
  if (!mix) return false;
  let depth = 0, split = -1;
  for (let i = 0; i < mix[1].length; i++) {
    if (mix[1][i] === '(') depth++;
    if (mix[1][i] === ')') depth--;
    if (mix[1][i] === ',' && depth === 0) { if (split !== -1) return false; split = i; }
    if (depth < 0) return false;
  }
  if (depth !== 0 || split < 0) return false;
  return [mix[1].slice(0, split), mix[1].slice(split + 1)].every(part => {
    const color = part.trim().replace(/\s+(?:100|\d{1,2}(?:\.\d+)?)%$/, '');
    return !(COLOR_TOKENS as readonly string[]).includes(color) && !color.startsWith('color-mix') && validColor(color);
  });
}
export function colorCss(value: string): string {
  return (COLOR_TOKENS as readonly string[]).includes(value)
    ? `var(--color-${value.replace(/_/g, '-')})` : validColor(value) ? value : '';
}
export interface TypographySettings { ratio_mobile?: number; ratio_desktop?: number; rhythm?: number; line_length?: number }
export const TYPOGRAPHY_DEFAULTS = { ratio_mobile: 1.2, ratio_desktop: 1.25, rhythm: 1, line_length: 65 } as const;
const number = (value: number) => Number(value.toFixed(5));
/** Fluid endpoints at 360/1280px. rem bounds preserve reader font preferences. */
function fluid(min: number, max: number, base: number): string {
  if (min === max) return `${number(min)}rem`;
  const slope = (max - min) * base / 920;
  return `clamp(${number(Math.min(min,max))}rem, ${number(min - slope * 360 / base)}rem ${slope >= 0 ? '+' : '-'} ${number(Math.abs(slope) * 100)}vw, ${number(Math.max(min,max))}rem)`;
}
export function resolvedDesignScales(scales?: DesignScales, typography?: TypographySettings, fluidDefaults = false, base = 16): DesignScales {
  const t = { ...TYPOGRAPHY_DEFAULTS, ...(!typographyError(typography) ? typography : {}) };
  const defaults: DesignScales = structuredClone(TOKEN_SCALES);
  if (fluidDefaults) {
    const powers: Record<string,number> = { xs:-2, sm:-1, md:0, lg:1, xl:2, '2xl':3, '3xl':5 };
    defaults.type_size = Object.fromEntries(Object.entries(powers).map(([step,power]) => [step,fluid(t.ratio_mobile ** power, t.ratio_desktop ** power, base)]));
    defaults.space = Object.fromEntries(Object.entries({ none:0, xs:0.25, sm:0.5, md:1, lg:1.5, xl:3 }).map(([step,n]) => [step, fluid(n * t.rhythm, n * t.rhythm * (n >= 1 ? 1.5 : 1), base)]));
  }
  const overrides = scales && !designScalesError(scales) ? scales : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, steps]) => [key, Object.fromEntries(
    Object.entries({ ...steps, ...overrides[key as TokenScale] }).map(([step, value]) => [step,
      typeof value === 'string' ? value : { mobile: steps[step], ...value },
    ]),
  )]));
}
/** Root declarations only; media queries are emitted outside :root. */
export function designScalesCss(scales?: DesignScales): string {
  return Object.entries(resolvedDesignScales(scales)).flatMap(([scale, steps]) => Object.entries(steps).flatMap(([step, value]) => {
    const scalar = typeof value === 'string' ? value : value.mobile ?? TOKEN_SCALES[scale as TokenScale][step as never];
    return scalar ? [`--${scale.replace('_', '-')}-${step}:${scalar};`] : [];
  })).join('');
}
export function responsiveDesignScalesCss(scales: DesignScales, widths: BreakpointWidths = resolveBreakpointWidths()): string {
  if (designScalesError(scales)) return '';
  return BREAKPOINT_ORDER.filter(bp => bp !== 'mobile').map(bp => {
    const declarations = Object.entries(scales).flatMap(([scale, steps]) => Object.entries(steps).flatMap(([step, value]) => typeof value !== 'string' && value[bp] ? [`--${scale.replace('_', '-')}-${step}:${value[bp]};`] : []));
    return declarations.length ? `@media(min-width:${widths[bp]}px){:root{${declarations.join('')}}}` : '';
  }).join('');
}
