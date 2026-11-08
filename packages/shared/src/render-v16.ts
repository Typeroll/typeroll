/**
 * Render version 16: block settings reach CSS as data attributes, platform
 * media queries follow the site's breakpoints, and values that used to be
 * written inline move into the instance layer, so plain site CSS can change
 * any of them without !important.
 * See docs/plans/responsive-defaults-and-cascade.md.
 */
import type { BlockType, FieldDefinition } from './types.js';
import { defaultBreakpointWidths, type BreakpointWidths } from './breakpoints.js';

export const DATA_ATTRIBUTE_RENDER_VERSION = 16;

/** `padding_y` → `data-padding-y`. */
export function fieldDataAttributeName(field: string): string {
  return `data-${field.replace(/_/g, '-')}`;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite selectors that read a select or number setting out of the inline
 * style text into data-attribute selectors:
 *   `[style*="--gap:sm"]`   → `[data-gap="sm"]`
 *   `[style*="--gap_px:"]`  → `[data-gap-px]`
 * Other style-text selectors (empty colours, derived variables) stay as they are.
 */
export function rewriteSettingSelectors(css: string, schema: readonly FieldDefinition[] | undefined): string {
  if (!css || !schema?.length || !css.includes('[style')) return css;
  let out = css;
  for (const field of schema) {
    if (field.type === 'select') {
      const name = escapeRegExp(field.name);
      out = out.replace(new RegExp(`\\[style\\*="--${name}:([^";]+)"\\]`, 'g'), (_m, value: string) => `[${fieldDataAttributeName(field.name)}="${value}"]`);
    } else if (field.css_unit) {
      const name = escapeRegExp(field.name);
      out = out.replace(new RegExp(`\\[style\\*="--${name}:"\\]`, 'g'), `[${fieldDataAttributeName(field.name)}]`);
    }
  }
  return out;
}

const attributeFieldCache = new WeakMap<object, Map<string, string[]>>();

/** Select and number fields the block type's version 16 CSS reads as data attributes. */
export function dataAttributeFields(blockType: Pick<BlockType, 'schema'>, css: string): string[] {
  let byCss = attributeFieldCache.get(blockType);
  if (!byCss) attributeFieldCache.set(blockType, byCss = new Map());
  const cached = byCss.get(css);
  if (cached) return cached;
  const names = (blockType.schema ?? [])
    .filter(field => (field.type === 'select' || field.css_unit) && new RegExp(`\\[${fieldDataAttributeName(field.name)}[\\]=~|^$*]`).test(css))
    .map(field => field.name);
  byCss.set(css, names);
  return names;
}

/** The data attributes for a block instance; unset values are left out. */
export function settingDataAttributes(
  blockType: Pick<BlockType, 'schema'>,
  data: Record<string, unknown>,
  css: string,
  numericValue: (field: FieldDefinition, raw: unknown) => string | undefined,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  const fields = new Map((blockType.schema ?? []).map(field => [field.name, field]));
  for (const name of dataAttributeFields(blockType, css)) {
    const field = fields.get(name)!;
    const raw = data[name];
    if (field.type === 'select') {
      if (typeof raw === 'string' && raw !== '' || typeof raw === 'number') attrs[fieldDataAttributeName(name)] = String(raw);
    } else {
      const value = numericValue(field, raw);
      if (value !== undefined) attrs[fieldDataAttributeName(name)] = value;
    }
  }
  return attrs;
}

/**
 * Hard-coded media query widths in platform block CSS follow the site's
 * named breakpoints: a literal maps to the nearest of tablet, laptop, desktop
 * and wide. Rules for a width the author chose (columns `stack_below`,
 * menu `collapse_below`, grid `stack_at`) keep their literal.
 */
export function mapMediaBreakpoints(css: string, widths: BreakpointWidths = defaultBreakpointWidths): string {
  if (!css.includes('@media')) return css;
  const named = [widths.tablet, widths.laptop, widths.desktop, widths.wide];
  const defaults = [defaultBreakpointWidths.tablet, defaultBreakpointWidths.laptop, defaultBreakpointWidths.desktop, defaultBreakpointWidths.wide];
  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < defaults.length; i++) if (Math.abs(defaults[i]! - px) < Math.abs(defaults[best]! - px)) best = i;
    return named[best]!;
  };
  let out = '';
  let index = 0;
  const atMedia = /@media\s*([^{]*)\{/g;
  let match: RegExpExecArray | null;
  while ((match = atMedia.exec(css))) {
    // Find the end of this @media block by brace depth.
    let depth = 1;
    let end = atMedia.lastIndex;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
      end++;
    }
    const body = css.slice(atMedia.lastIndex, end);
    let query = match[1]!;
    if (!/\[data-(?:stack-below|stack-at|collapse|collapse-below)=/.test(body)) {
      query = query
        .replace(/max-width:\s*(\d+)px/g, (_m, px: string) => `max-width: ${nearest(Number(px) + 1) - 1}px`)
        .replace(/min-width:\s*(\d+)px/g, (_m, px: string) => `min-width: ${nearest(Number(px))}px`);
    }
    out += css.slice(index, match.index) + (query === match[1] ? match[0] : `@media ${query.trimStart()}{`) + body;
    index = end;
    atMedia.lastIndex = end;
  }
  return out + css.slice(index);
}

/**
 * Remove custom properties from the root element's inline style and return
 * their values, so the instance layer can set them instead.
 */
export function takeInlineCustomProperties(html: string, names: readonly string[]): { html: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  if (!names.length) return { html, values };
  const firstTag = /^(<[a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\s*\/?>)/;
  const updated = html.replace(firstTag, (_m, open: string, attrs: string, close: string) => {
    const next = attrs.replace(/(\sstyle=")([^"]*)(")/, (_s, p1: string, style: string, p3: string) => {
      const kept = style.split(';').filter(declaration => {
        const colon = declaration.indexOf(':');
        const name = declaration.slice(0, colon).trim();
        if (colon > 0 && name.startsWith('--') && names.includes(name.slice(2))) {
          values[name.slice(2)] = declaration.slice(colon + 1).trim();
          return false;
        }
        return true;
      });
      const rest = kept.join(';');
      return rest.trim() ? `${p1}${rest}${p3}` : '';
    });
    return `${open}${next}${close}`;
  });
  return { html: updated, values };
}

/**
 * Per-instance values that used to be written inline, applied from the
 * instance layer: authored spacing and an image's maximum width.
 */
export const INSTANCE_RUNTIME_CSS_V16 = `
[data-space-before] { margin-top:var(--space-before); }
[data-space-after] { margin-bottom:var(--space-after); }
`.trim();

/** The image part of the instance runtime, shipped only with an Image block. */
export const IMAGE_INSTANCE_CSS_V16 = '[data-block="image"][data-max-width] { max-width:var(--image-max); }';
