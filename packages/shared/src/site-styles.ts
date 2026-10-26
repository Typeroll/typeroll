/**
 * Site style library: named, author-created styles stored in
 * `SiteSettings.styles`. See docs/plans/design-system-and-render-versions.md.
 *
 * - Element roles (body, h1–h6, link) style every matching element on the
 *   site. They are emitted as CSS custom properties that platform CSS reads
 *   with its previous values as fallbacks, so a site without styles renders
 *   exactly as before.
 * - Every other style is a class (`s-<id>`) an author selects on a block.
 *   The class lands on the block's semantic element.
 *
 * Values are structured and validated; no style can inject arbitrary CSS
 * except the optional `css` field, which is scoped to the style's selector.
 */

import type { BreakpointWidths } from './breakpoints.js';
import { apcaContrast, contrastRatio, formatContrast, onColorApca, onColorWcag, textContrast, type TextContrast, type TextSpec, type TextUse } from './contrast.js';

export const STYLE_ELEMENT_ROLES = ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'link'] as const;
export type StyleElementRole = typeof STYLE_ELEMENT_ROLES[number];
/** Standard class roles: created by default, chosen per block. */
export const STYLE_CLASS_ROLES = ['lead', 'eyebrow', 'small', 'quote', 'button', 'button_secondary', 'section'] as const;
export type StyleClassRole = typeof STYLE_CLASS_ROLES[number];
export type StyleRole = StyleElementRole | StyleClassRole;

/**
 * Kinds of element a style can be chosen for: a block's `style` field
 * (`style_target`) and a block part (`BlockPart.target`, block-parts.ts)
 * list the styles of their kind.
 */
export const STYLE_TARGETS = ['text', 'heading', 'list', 'button', 'container', 'link', 'image'] as const;
export type StyleTarget = typeof STYLE_TARGETS[number];

export const STYLE_BREAKPOINTS = ['tablet', 'laptop', 'desktop', 'wide'] as const;
export type StyleBreakpoint = typeof STYLE_BREAKPOINTS[number];

export { PALETTE_TOKENS, ON_COLOR_TOKENS, COLOR_TOKENS } from './design-tokens.js';
import { PALETTE_TOKENS, ON_COLOR_TOKENS, COLOR_TOKENS, colorCss, validColor, scaleCss, scaleValue, spacingCss } from './design-tokens.js';

export interface StyleBorder {
  width?: string;
  style?: 'solid' | 'dashed' | 'dotted' | 'none';
  color?: string;
  sides?: 'all' | 'top' | 'right' | 'bottom' | 'left' | 'block' | 'inline';
}

export interface StyleProps {
  font?: 'heading' | 'body' | 'mono' | 'inherit';
  size?: string;
  weight?: number;
  line_height?: string;
  letter_spacing?: string;
  transform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  italic?: boolean;
  color?: string;
  background?: string;
  align?: 'left' | 'center' | 'right' | 'start' | 'end' | 'justify';
  decoration?: 'none' | 'underline';
  space_before?: string;
  space_after?: string;
  padding?: string;
  max_width?: string;
  radius?: string;
  border?: StyleBorder;
  /** 0 (invisible) to 1 (opaque). */
  opacity?: number;
  /** A shadow preset; `none` removes one the block draws (e.g. an outline button's inset ring). */
  shadow?: StyleShadow;
  /** Space between the children of a flex or grid element: one length, or row and column. */
  gap?: string;
}

export const STYLE_SHADOWS = { none: 'none', sm: '0 1px 2px rgb(0 0 0 / .08)', md: '0 4px 12px rgb(0 0 0 / .12)', lg: '0 12px 32px rgb(0 0 0 / .16)' } as const;
export type StyleShadow = keyof typeof STYLE_SHADOWS;

export interface SiteStyle {
  /** Stable slug; the class is `s-<id>`. */
  id: string;
  /** Author-chosen display name. */
  name: string;
  /** Standard role, when this is one of the default styles. */
  role?: StyleRole;
  /** Block kinds that may select this style (ignored for element roles). */
  targets: StyleTarget[];
  description?: string;
  /** Mobile-first base values. */
  base: StyleProps;
  /** Overrides from each breakpoint upward. */
  at?: Partial<Record<StyleBreakpoint, StyleProps>>;
  hover?: Pick<StyleProps, 'color' | 'background' | 'decoration'>;
  /** Advanced CSS. `&` is the style's selector; only declarations and nested
   *  `&…` rules are allowed. */
  css?: string;
  /**
   * Block parts this style applies to on every instance by default, as
   * `<block type id>.<part name>` (e.g. `core/rich_heading.link`). An
   * instance's own choice (`part_styles`, or a style class on the element)
   * wins. See block-parts.ts.
   */
  parts?: string[];
  updated_at?: string;
}

export const STYLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
/** A block part reference: `<block type id>.<part name>`, e.g. `core/rich_heading.link`. */
export const BLOCK_PART_REF_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}(?:\/[a-z0-9][a-z0-9_-]{0,63})?\.[a-z][a-z0-9_]{0,31}$/;
/** Most block parts one style may apply to site-wide. */
export const MAX_STYLE_PARTS = 32;

const LENGTH = /^(?:0|-?(?:\d+|\d*\.\d+)(?:px|rem|em|%|vw|vh|ch))$/;
const CLAMP = /^(?:clamp|min|max)\([0-9a-z.%+\-*/,\s()]+\)$/;
const NUMBER = /^(?:\d+|\d*\.\d+)$/;

const isLength = (value: unknown): value is string => typeof value === 'string' && (LENGTH.test(value.trim()) || CLAMP.test(value.trim()));
const isColor = validColor;
const isSpacing = (value: unknown): value is string => typeof value === 'string' && value.trim().split(/\s+/).length <= 4 && value.trim().split(/\s+/).every(part => (isLength(part) || !!scaleValue('space', part)));

/** Every style property, in the order generated CSS writes them. */
export const STYLE_PROP_KEYS = ['font', 'size', 'weight', 'line_height', 'letter_spacing', 'transform', 'italic', 'color', 'background', 'align', 'decoration', 'space_before', 'space_after', 'padding', 'max_width', 'radius', 'border', 'opacity', 'shadow', 'gap'] as const;

function propsErrors(props: unknown, where: string): string[] {
  if (props == null) return [];
  if (typeof props !== 'object' || Array.isArray(props)) return [`${where} must be an object`];
  const p = props as Record<string, unknown>;
  const errors: string[] = [];
  const known = new Set<string>(STYLE_PROP_KEYS);
  for (const key of Object.keys(p)) if (!known.has(key)) errors.push(`${where}.${key} is not a style property`);
  const check = (key: string, ok: (value: unknown) => boolean, expected: string) => {
    if (p[key] !== undefined && !ok(p[key])) errors.push(`${where}.${key} must be ${expected}`);
  };
  check('font', v => ['heading', 'body', 'mono', 'inherit'].includes(v as string), 'heading, body, mono or inherit');
  check('size', v => isLength(v) || !!scaleValue('type_size', v), 'a CSS length (px, rem, em, %, vw, ch) or clamp()');
  check('weight', v => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 900 && (v as number) % 100 === 0, '100–900 in steps of 100');
  check('line_height', v => typeof v === 'string' && (NUMBER.test(v) || isLength(v) || !!scaleValue('leading', v)), 'a number such as "1.5" or a length');
  check('letter_spacing', v => v === 'normal' || isLength(v), 'a length such as "0.08em" or "normal"');
  check('transform', v => ['none', 'uppercase', 'lowercase', 'capitalize'].includes(v as string), 'none, uppercase, lowercase or capitalize');
  check('italic', v => typeof v === 'boolean', 'true or false');
  check('color', isColor, `a colour token (${COLOR_TOKENS.join(', ')}) or a hex/rgb/hsl colour`);
  check('background', isColor, `a colour token (${COLOR_TOKENS.join(', ')}) or a hex/rgb/hsl colour`);
  check('align', v => ['left', 'center', 'right', 'start', 'end', 'justify'].includes(v as string), 'left, center, right, start, end or justify');
  check('decoration', v => ['none', 'underline'].includes(v as string), 'none or underline');
  for (const key of ['space_before', 'space_after', 'max_width', 'radius']) check(key, v => isLength(v) || (['space_before', 'space_after'].includes(key) && !!scaleValue('space', v)), 'a CSS length or spacing step');
  check('padding', isSpacing, 'one to four CSS lengths');
  check('opacity', v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1, 'a number from 0 to 1');
  check('shadow', v => typeof v === 'string' && Object.hasOwn(STYLE_SHADOWS, v), `one of ${Object.keys(STYLE_SHADOWS).join(', ')}`);
  check('gap', v => isSpacing(v) && (v as string).trim().split(/\s+/).length <= 2, 'one or two CSS lengths');
  if (p.border !== undefined) {
    const b = p.border as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b)) errors.push(`${where}.border must be an object`);
    else {
      if (b.width !== undefined && !isLength(b.width)) errors.push(`${where}.border.width must be a CSS length`);
      if (b.style !== undefined && !['solid', 'dashed', 'dotted', 'none'].includes(b.style as string)) errors.push(`${where}.border.style must be solid, dashed, dotted or none`);
      if (b.color !== undefined && !isColor(b.color)) errors.push(`${where}.border.color must be a colour`);
      if (b.sides !== undefined && !['all', 'top', 'right', 'bottom', 'left', 'block', 'inline'].includes(b.sides as string)) errors.push(`${where}.border.sides must be all, top, right, bottom, left, block or inline`);
    }
  }
  return errors;
}

function cssFieldError(css: unknown): string | null {
  if (css === undefined || css === '') return null;
  if (typeof css !== 'string') return 'css must be a string';
  if (css.length > 8000) return 'css is limited to 8000 characters';
  if (/<|@import|@charset|expression\s*\(|javascript:|behavior\s*:/i.test(css)) return 'css may not contain markup, @import or script URLs';
  let depth = 0;
  for (const char of css) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return 'css has an unmatched "}"';
  }
  if (depth !== 0) return 'css has an unmatched "{"';
  return null;
}

/** Validate an untrusted style. Returns the normalized style or errors. */
export function validateSiteStyle(input: unknown): { style?: SiteStyle; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['style must be an object'] };
  const s = input as Record<string, unknown>;
  const errors: string[] = [];
  const known = new Set(['id', 'name', 'role', 'targets', 'description', 'base', 'at', 'hover', 'css', 'parts', 'updated_at']);
  for (const key of Object.keys(s)) if (!known.has(key)) errors.push(`${key} is not a style field`);
  if (typeof s.id !== 'string' || !STYLE_ID_PATTERN.test(s.id)) errors.push('id must start with a letter and contain only a-z, 0-9 and - (max 48)');
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 80) errors.push('name is required (max 80 characters)');
  const roles: readonly string[] = [...STYLE_ELEMENT_ROLES, ...STYLE_CLASS_ROLES];
  if (s.role !== undefined && !roles.includes(s.role as string)) errors.push(`role must be one of ${roles.join(', ')}`);
  const targets = s.targets === undefined ? [] : s.targets;
  if (!Array.isArray(targets) || targets.some(t => !(STYLE_TARGETS as readonly string[]).includes(t))) errors.push(`targets must list ${STYLE_TARGETS.join(', ')}`);
  if (s.description !== undefined && (typeof s.description !== 'string' || s.description.length > 300)) errors.push('description must be text (max 300 characters)');
  errors.push(...propsErrors(s.base ?? {}, 'base'));
  if (s.at !== undefined) {
    if (!s.at || typeof s.at !== 'object' || Array.isArray(s.at)) errors.push('at must be an object');
    else for (const [bp, props] of Object.entries(s.at as Record<string, unknown>)) {
      if (!(STYLE_BREAKPOINTS as readonly string[]).includes(bp)) errors.push(`at.${bp} is not a breakpoint (${STYLE_BREAKPOINTS.join(', ')})`);
      else errors.push(...propsErrors(props, `at.${bp}`));
    }
  }
  if (s.hover !== undefined) {
    errors.push(...propsErrors(s.hover, 'hover'));
    for (const key of Object.keys((s.hover ?? {}) as object)) if (!['color', 'background', 'decoration'].includes(key)) errors.push(`hover supports only color, background and decoration`);
  }
  const cssError = cssFieldError(s.css);
  if (cssError) errors.push(cssError);
  if (s.parts !== undefined) {
    if (!Array.isArray(s.parts) || s.parts.length > MAX_STYLE_PARTS) errors.push(`parts must be a list of at most ${MAX_STYLE_PARTS} block parts`);
    else {
      for (const ref of s.parts) if (typeof ref !== 'string' || !BLOCK_PART_REF_PATTERN.test(ref)) errors.push(`parts: ${JSON.stringify(ref)} is not a block part; write <block type>.<part>, e.g. core/rich_heading.link (read_block_type lists a block's parts)`);
      if (s.role && (STYLE_ELEMENT_ROLES as readonly string[]).includes(s.role as string) && s.parts.length) errors.push(`parts: a ${s.role} element role already styles every matching element; give the part a class style instead`);
    }
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    style: {
      id: s.id as string,
      name: (s.name as string).trim(),
      ...(s.role ? { role: s.role as StyleRole } : {}),
      targets: [...new Set(targets as StyleTarget[])],
      ...(s.description ? { description: s.description as string } : {}),
      base: (s.base ?? {}) as StyleProps,
      ...(s.at ? { at: s.at as SiteStyle['at'] } : {}),
      ...(s.hover ? { hover: s.hover as SiteStyle['hover'] } : {}),
      ...(s.css ? { css: s.css as string } : {}),
      ...(Array.isArray(s.parts) && s.parts.length ? { parts: [...new Set(s.parts as string[])] } : {}),
      ...(typeof s.updated_at === 'string' ? { updated_at: s.updated_at } : {}),
    },
  };
}

/** Errors that concern the library as a whole (duplicate ids, roles or block parts). */
export function siteStyleLibraryErrors(styles: SiteStyle[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const roles = new Set<string>();
  const parts = new Map<string, string>();
  for (const style of styles) {
    if (ids.has(style.id)) errors.push(`Duplicate style id "${style.id}"`);
    ids.add(style.id);
    if (style.role) {
      if (roles.has(style.role)) errors.push(`More than one style has the role "${style.role}"`);
      roles.add(style.role);
    }
    for (const ref of style.parts ?? []) {
      const owner = parts.get(ref);
      if (owner) errors.push(`Both "${owner}" and "${style.id}" apply to the block part ${ref}; a part takes one site-wide style`);
      else parts.set(ref, style.id);
    }
  }
  return errors;
}

// ── Colour and contrast ─────────────────────────────────────────────────

export type PaletteToken = typeof PALETTE_TOKENS[number];
export type OnColorToken = typeof ON_COLOR_TOKENS[number];
/** Palette colours plus the optional explicit text colours on primary, secondary and accent. */
export type SiteColors = Partial<Record<PaletteToken | OnColorToken, string>>;

/**
 * From this render version the automatic on_* text colour is chosen by APCA
 * instead of the WCAG 2 ratio. An explicit `colors.on_*` applies on every
 * version.
 */
export const APCA_ON_COLOR_RENDER_VERSION = 8;

const ON_COLOR_VALUE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** An explicit on_* colour: an opaque hex colour (#rgb or #rrggbb), so its contrast can be measured. */
export function isOnColorValue(value: unknown): value is string {
  return typeof value === 'string' && ON_COLOR_VALUE.test(value.trim());
}

/** The palette colour an on_* token is text on: on_primary → primary. */
export function onColorBase(token: OnColorToken): PaletteToken {
  return token.slice(3) as PaletteToken;
}

/**
 * Near-black or white, whichever reads better on `background`: by the WCAG 2
 * ratio before render version 8 (the output those versions always had), by
 * APCA from version 8. WCAG 2 overrates dark text on mid-dark saturated
 * colours: on #00a19c it picks #111827 (5.56:1, Lc 44) over white (3.19:1,
 * Lc 63.9).
 */
export function onColor(background: string | undefined, renderVersion = 1): string {
  return renderVersion >= APCA_ON_COLOR_RENDER_VERSION ? onColorApca(background) : onColorWcag(background);
}

/** The text colour an on_* token renders with: the site's explicit choice, else the automatic one. */
export function onColorValue(token: OnColorToken, colors: SiteColors, renderVersion = 1): string {
  const explicit = colors[token];
  return isOnColorValue(explicit) ? explicit.trim() : onColor(colors[onColorBase(token)], renderVersion);
}

/** Resolve a style colour (token or literal) to a concrete colour string. */
export function resolveStyleColor(value: string | undefined, colors: SiteColors, renderVersion = 1): string | undefined {
  if (!value) return undefined;
  if ((ON_COLOR_TOKENS as readonly string[]).includes(value)) return onColorValue(value as OnColorToken, colors, renderVersion);
  if ((PALETTE_TOKENS as readonly string[]).includes(value)) return colors[value as PaletteToken];
  return value;
}

function pxSize(size: string | undefined): number | null {
  if (!size) return null;
  const m = size.trim().match(/^(\d*\.?\d+)(px|rem|em)$/);
  if (!m) return null;
  return m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16;
}

const HEADING_ROLES: readonly string[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/**
 * How a style's text is read, for the contrast it needs. Headings, eyebrows
 * and buttons are non-body text; small text is secondary (sub-fluent); body
 * text, leads, quotes, links and sections are body text. A style without a
 * standard role is non-body text only when it can be chosen for headings and
 * buttons alone.
 */
export function styleTextUse(style: Pick<SiteStyle, 'role' | 'targets'>): TextUse {
  const role = style.role ?? '';
  if (HEADING_ROLES.includes(role) || ['eyebrow', 'button', 'button_secondary'].includes(role)) return 'content';
  if (role === 'small') return 'sub_fluent';
  if (role) return 'body';
  return style.targets.length && style.targets.every(target => target === 'heading' || target === 'button') ? 'content' : 'body';
}

export interface StyleContrastOptions {
  /** Site render version: decides the automatic on_* colours. */
  renderVersion?: number;
  /**
   * Where the style's text sits besides the site background: one entry per
   * block part it styles (see `partContrastSurfaces` in block-parts.ts). A
   * surface gives the text and background colour the part has when the style
   * sets neither, and how its text is read.
   */
  surfaces?: readonly StyleContrastSurface[];
  /** Measure only on `surfaces`, not also as a class style on the site background. */
  surfacesOnly?: boolean;
}

/** The text and background a style's text has where it is used, when the style sets neither. */
export interface StyleContrastSurface {
  /** Shown in messages, e.g. `core/hero.primary_button`. */
  label: string;
  /** Colour token or colour of the text when the style sets none (default `text`). */
  color?: string;
  /** Colour token or colour behind the text when the style sets none (default `background`). */
  background?: string;
  /** How the text is read; defaults to the style's own use (`styleTextUse`). */
  use?: TextUse;
}

export interface StyleContrastReport {
  /** Fails both APCA and WCAG 2 AA: the style is refused. */
  errors: string[];
  /** Fails APCA but meets WCAG 2 AA: accepted, reported. */
  warnings: string[];
}

/**
 * Text contrast of a style against the site's colours, at every breakpoint
 * and on hover.
 *
 * APCA decides (`requiredContrast`, by the text's use, size and weight). A
 * style that misses its APCA level but meets WCAG 2 AA is accepted with a
 * warning: WCAG 2 AA is the legal baseline many sites must meet, and every
 * style accepted before APCA stays accepted. A style that fails both is
 * clearly unreadable and refused. Messages give both measures.
 *
 * With `surfaces`, the style is also measured where each block part it
 * styles sits, e.g. on a primary button's `primary` background unless the
 * style sets its own.
 */
export function styleContrastReport(style: SiteStyle, colors: SiteColors, opts: StyleContrastOptions = {}): StyleContrastReport {
  const renderVersion = opts.renderVersion ?? 1;
  const report: StyleContrastReport = { errors: [], warnings: [] };
  const ownUse = styleTextUse(style);
  const defaultWeight = HEADING_ROLES.includes(style.role ?? '') ? 700 : 400;
  const reported = new Set<string>();
  const check = (where: string, colorToken: string, backgroundToken: string, props: StyleProps, use: TextUse) => {
    const fg = resolveStyleColor(colorToken, colors, renderVersion);
    const bg = resolveStyleColor(backgroundToken, colors, renderVersion);
    const measured = textContrast(fg, bg, { use, px: pxSize(props.size), weight: props.weight ?? defaultWeight });
    if (!measured || measured.apca_pass) return;
    const { required } = measured;
    const pair = `${style.name} (${where}): ${measured.text} on ${measured.background} is ${formatContrast(measured)}`;
    if (reported.has(pair)) return;
    reported.add(pair);
    if (!measured.wcag_pass) {
      report.errors.push(`${pair}. ${required.label} needs APCA Lc ${required.lc} or WCAG 2 ${required.wcag}:1. Choose a text colour with more contrast or a different background.`);
      return;
    }
    let hint = '';
    if ((ON_COLOR_TOKENS as readonly string[]).includes(colorToken) && !isOnColorValue(colors[colorToken as OnColorToken])) {
      const apcaChoice = onColor(bg, APCA_ON_COLOR_RENDER_VERSION);
      if (apcaChoice !== fg) hint = ` Render version ${APCA_ON_COLOR_RENDER_VERSION} chooses ${apcaChoice} for ${colorToken} here; or set colors.${colorToken}.`;
    }
    report.warnings.push(`${pair}: below APCA Lc ${required.lc} for ${required.label}, accepted because it meets WCAG 2 AA (${required.wcag}:1).${hint}`);
  };
  const surfaces: Array<{ label?: string; color: string; background: string; use: TextUse }> = [
    ...(opts.surfacesOnly && opts.surfaces?.length ? [] : [{ color: 'text', background: 'background', use: ownUse }]),
    ...(opts.surfaces ?? []).map(surface => ({ label: surface.label, color: surface.color ?? 'text', background: surface.background ?? 'background', use: surface.use ?? ownUse })),
  ];
  const layers: [string, StyleProps][] = [['base', style.base], ...STYLE_BREAKPOINTS.filter(bp => style.at?.[bp]).map(bp => [bp, style.at![bp]!] as [string, StyleProps])];
  for (const surface of surfaces) {
    const at = (where: string) => surface.label ? `${where} on ${surface.label}` : where;
    let props: StyleProps = {};
    for (const [where, layer] of layers) {
      props = { ...props, ...layer };
      check(at(where), props.color ?? surface.color, props.background ?? surface.background, props, surface.use);
    }
    if (style.hover?.color || style.hover?.background) {
      check(at('hover'), style.hover.color ?? props.color ?? surface.color, style.hover.background ?? props.background ?? surface.background, props, surface.use);
    }
  }
  return report;
}

/** Contrast errors for a style: text that fails both APCA and WCAG 2 AA. See `styleContrastReport`. */
export function styleContrastErrors(style: SiteStyle, colors: SiteColors, opts: StyleContrastOptions = {}): string[] {
  return styleContrastReport(style, colors, opts).errors;
}

export interface OnColorContrast extends TextContrast {
  token: OnColorToken;
  /** True when the site set the colour; false for the automatic choice. */
  explicit: boolean;
}

/**
 * The on_* text colours a site renders with and their contrast on their
 * palette colour, measured as text on a button (16px at weight 600, APCA
 * Lc 60).
 */
export function onColorContrasts(colors: SiteColors, renderVersion = 1): OnColorContrast[] {
  return ON_COLOR_TOKENS.flatMap(token => {
    const measured = textContrast(onColorValue(token, colors, renderVersion), colors[onColorBase(token)], ON_COLOR_TEXT);
    return measured ? [{ ...measured, token, explicit: isOnColorValue(colors[token]) }] : [];
  });
}

/** The text on_* colours are measured for: button text, 16px at weight 600. */
export const ON_COLOR_TEXT: TextSpec = { use: 'content', px: 16, weight: 600 };

/**
 * Warnings for explicit on_* colours that do not reach the button level
 * (APCA Lc 60 at 16px/600). The colour is kept: it is the site's choice.
 */
export function onColorWarnings(colors: SiteColors, renderVersion = 1): string[] {
  return onColorContrasts(colors, renderVersion).filter(item => item.explicit && !item.apca_pass).map(item => {
    const automatic = onColor(item.background, renderVersion);
    const alternative = automatic.toLowerCase() === item.text.toLowerCase() ? '' : ` The automatic choice would be ${automatic} (${formatContrast({ lc: apcaContrast(automatic, item.background) ?? 0, wcag: contrastRatio(automatic, item.background) ?? 0 })}).`;
    return `colors.${item.token} ${item.text} on ${onColorBase(item.token)} ${item.background} is ${formatContrast(item)}, below APCA Lc ${item.required.lc} for ${item.required.label} such as buttons.${alternative}`;
  });
}

// ── CSS generation ──────────────────────────────────────────────────────


const fontCss = (value: NonNullable<StyleProps['font']>) => value === 'inherit' ? 'inherit'
  : value === 'mono' ? "var(--font-mono, ui-monospace), monospace"
  : `var(--font-${value}), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;

function declarations(p: StyleProps): string[] {
  const out: string[] = [];
  if (p.font) out.push(`font-family:${fontCss(p.font)}`);
  if (p.size) out.push(`font-size:${scaleCss('type_size', p.size)}`);
  if (p.weight) out.push(`font-weight:${p.weight}`);
  if (p.line_height) out.push(`line-height:${scaleCss('leading', p.line_height)}`);
  if (p.letter_spacing) out.push(`letter-spacing:${p.letter_spacing}`);
  if (p.transform) out.push(`text-transform:${p.transform}`);
  if (p.italic !== undefined) out.push(`font-style:${p.italic ? 'italic' : 'normal'}`);
  if (p.color) out.push(`color:${colorCss(p.color)}`);
  if (p.background) out.push(`background-color:${colorCss(p.background)}`);
  if (p.align) out.push(`text-align:${p.align}`);
  if (p.decoration) out.push(`text-decoration:${p.decoration}`, ...(p.decoration === 'underline' ? ['text-underline-offset:.15em'] : []));
  if (p.space_before) out.push(`margin-block-start:${scaleCss('space', p.space_before)}`);
  if (p.space_after) out.push(`margin-block-end:${scaleCss('space', p.space_after)}`);
  if (p.padding) out.push(`padding:${spacingCss(p.padding)}`);
  if (p.max_width) out.push(`max-width:${p.max_width}`);
  if (p.radius) out.push(`border-radius:${p.radius}`);
  if (p.border) {
    const b = p.border;
    const value = `${b.width ?? '1px'} ${b.style ?? 'solid'} ${b.color ? colorCss(b.color) : 'currentColor'}`;
    const side = b.sides && b.sides !== 'all' ? `-${b.sides}` : '';
    out.push(`border${side}:${value}`);
  }
  if (p.opacity !== undefined) out.push(`opacity:${p.opacity}`);
  if (p.shadow) out.push(`box-shadow:${STYLE_SHADOWS[p.shadow]}`);
  if (p.gap) out.push(`gap:${spacingCss(p.gap)}`);
  return out;
}

/** Element roles become custom properties read by platform CSS. */
function roleVariables(role: StyleElementRole, p: StyleProps): string[] {
  const out: string[] = [];
  if (role === 'body') {
    if (p.size) out.push(`--body-size:${scaleCss('type_size', p.size)}`);
    if (p.line_height) out.push(`--body-leading:${scaleCss('leading', p.line_height)}`, `--body-leading-text:${scaleCss('leading', p.line_height)}`);
    if (p.color) out.push(`--body-color:${colorCss(p.color)}`);
    if (p.font) out.push(`--body-font:${fontCss(p.font)}`);
    return out;
  }
  if (role === 'link') {
    if (p.color) out.push(`--link-color:${colorCss(p.color)}`);
    if (p.decoration) out.push(`--link-decoration:${p.decoration}`);
    if (p.weight) out.push(`--link-weight:${p.weight}`);
    return out;
  }
  if (p.size) out.push(`--type-${role}:${scaleCss('type_size', p.size)}`, `--${role}-size:${scaleCss('type_size', p.size)}`);
  if (p.weight) out.push(`--${role}-weight:${p.weight}`);
  if (p.line_height) out.push(`--${role}-leading:${scaleCss('leading', p.line_height)}`);
  if (p.letter_spacing) out.push(`--${role}-tracking:${p.letter_spacing}`);
  if (p.transform) out.push(`--${role}-transform:${p.transform}`);
  if (p.italic !== undefined) out.push(`--${role}-style:${p.italic ? 'italic' : 'normal'}`);
  if (p.color) out.push(`--${role}-color:${colorCss(p.color)}`);
  if (p.font) out.push(`--${role}-font:${fontCss(p.font)}`);
  return out;
}

export function styleClassName(id: string): string {
  return `s-${id}`;
}

function scopedCss(css: string, selector: string): string {
  // Bare declarations apply to the style itself; `&` stands for its selector.
  const trimmed = css.trim();
  if (!trimmed) return '';
  if (!trimmed.includes('{')) return `${selector}{${trimmed}}`;
  return trimmed.replace(/&/g, selector);
}

/**
 * The rules of a class style for the given selectors: base values, each
 * breakpoint upward, hover and the scoped advanced CSS. Each selector must be
 * one complex selector (no top-level comma), since hover and `&` attach to it.
 * Block parts reuse this with their own selectors (block-parts.ts).
 */
export function styleRules(style: SiteStyle, selectors: readonly string[], breakpoints: BreakpointWidths): string[] {
  const rules: string[] = [];
  const selector = selectors.join(',');
  const base = declarations(style.base);
  if (base.length) rules.push(`${selector}{${base.join(';')}}`);
  for (const bp of STYLE_BREAKPOINTS) {
    const decls = style.at?.[bp] ? declarations(style.at[bp]!) : [];
    if (decls.length) rules.push(`@media (min-width:${breakpoints[bp]}px){${selector}{${decls.join(';')}}}`);
  }
  if (style.hover) {
    const hover = declarations(style.hover);
    if (hover.length) rules.push(`${selectors.map(one => `${one}:hover`).join(",")}{${hover.join(";")}}`);
  }
  if (style.css) for (const one of selectors) rules.push(scopedCss(style.css, one));
  return rules;
}

export interface SiteStylesCssOptions {
  breakpoints: BreakpointWidths;
  /** Site palette, used to derive the on_* text colours (explicit `on_*` values win). */
  colors: SiteColors;
  /** Site render version (render-version.ts); version 2 adds role defaults and a readable --color-primary-fg, version 3 palette-derived theme tokens, version 8 the APCA choice of on_* colours. */
  renderVersion?: number;
}

/**
 * Class roles a block part uses by default when no style is chosen (render
 * version 2): a heading's eyebrow and subtitle get `tr-role-eyebrow` and
 * `tr-role-lead`, styled by the site's first style with that role.
 */
export const STYLE_DEFAULT_ROLE_CLASSES: readonly StyleClassRole[] = ['eyebrow', 'lead'];

/**
 * CSS for a site's style library and its on_* text colours. Empty for a
 * site on render version 1 without styles or explicit on_* colours. Class
 * styles get an id-level specificity boost so a chosen style wins over the
 * block's own default appearance (but not over `!important` utilities).
 */
export function siteStylesCss(input: readonly unknown[] | undefined, opts: SiteStylesCssOptions): string {
  // Re-validate: stored data is rendered into a <style> element.
  const styles = (Array.isArray(input) ? input : []).flatMap(value => validateSiteStyle(value).style ?? []);
  const renderVersion = opts.renderVersion ?? 1;
  const v2 = renderVersion >= 2;
  // An explicit on_* colour is the site's choice and applies on every version.
  const explicit = new Set(ON_COLOR_TOKENS.filter(token => isOnColorValue(opts.colors[token])));
  if (!styles.length && !v2 && !explicit.size) return '';
  const defaultRoles = new Set<string>();
  const rootByBp = new Map<string, string[]>();
  const rules: string[] = [];
  if (renderVersion >= 10) rules.push(
    ':is([data-block="container"],[data-block="semantic-container"])[data-rhythm="article"] > :is([data-block="heading"],[data-block="rich_heading"]){margin-block:var(--heading_before_px,0px) var(--heading_after_px,0px)}',
    ':where([data-block="container"],[data-block="semantic-container"],.block-section-inner) > :is(h1,h2,h3,h4,h5,h6):first-child, :where([data-block="container"],[data-block="semantic-container"],.block-section-inner) > :is([data-block="heading"],[data-block="rich_heading"],[data-block="prose"]):first-child :is(h1,h2,h3,h4,h5,h6):first-child{margin-block-start:0}',
    '[data-block]:not(:where([data-block="heading"],[data-block="rich_heading"],[data-block="prose"],[data-block="container"],[data-block="semantic-container"],[data-block="section"],[data-block="template_content_slot"])) :where(h1,h2,h3,h4,h5,h6){margin-block:0}',
  );
  const media = (bp: StyleBreakpoint) => `@media (min-width:${opts.breakpoints[bp]}px)`;
  const pushRoot = (key: string, decls: string[]) => { if (decls.length) rootByBp.set(key, [...(rootByBp.get(key) ?? []), ...decls]); };
  for (const style of styles) {
    const role = style.role as StyleElementRole | undefined;
    if (role && (STYLE_ELEMENT_ROLES as readonly string[]).includes(role)) {
      const spacing = (props: StyleProps) => /^h[1-6]$/.test(role) ? [props.space_before ? `margin-block-start:${scaleCss('space', props.space_before)}` : '', props.space_after ? `margin-block-end:${scaleCss('space', props.space_after)}` : ''].filter(Boolean).join(';') : '';
      const selector = `${role}:not(#\\#)`;
      // Role rhythm belongs to editorial flow, not to component-owned titles.
      const rhythmSelector = renderVersion >= 10
        ? `:where([data-block="heading"], [data-block="prose"], .page-content) ${selector}:not(:where([data-block]:not([data-block="heading"]):not([data-block="prose"]):not([data-block="container"]):not([data-block="semantic-container"]):not([data-block="rich_heading"]):not([data-block="section"]):not([data-block="template_content_slot"]) *))`
        : selector;
      const opening = ':where([data-block="container"], [data-block="semantic-container"], .block-section-inner) > :where(h1,h2,h3,h4,h5,h6):first-child, :where([data-block="container"], [data-block="semantic-container"], .block-section-inner) > :where([data-block="heading"], [data-block="rich_heading"], [data-block="prose"]):first-child :where(h1,h2,h3,h4,h5,h6):first-child';
      const rhythm = (value: string) => /^\d+(?:\.\d+)?em$/.test(value) ? `calc(${value} * var(--type-rhythm,1))` : scaleCss('space',value);
      const emitSpacing = (props: StyleProps) => {
        if (renderVersion < 10) return spacing(props) ? `${selector}{${spacing(props)}}` : '';
        if (!/^h[1-6]$/.test(role)) return '';
        return [props.space_before ? `${rhythmSelector}:not(:where(${opening})){margin-block-start:${rhythm(props.space_before)}}` : '', props.space_after ? `${rhythmSelector}{margin-block-end:${rhythm(props.space_after)}}` : ''].join('');
      };
      if (emitSpacing(style.base)) rules.push(emitSpacing(style.base));
      for (const bp of STYLE_BREAKPOINTS) if (style.at?.[bp] && emitSpacing(style.at[bp]!)) rules.push(`${media(bp)}{${emitSpacing(style.at[bp]!)}}`);
      pushRoot('base', roleVariables(role, style.base));
      for (const bp of STYLE_BREAKPOINTS) if (style.at?.[bp]) pushRoot(bp, roleVariables(role, style.at[bp]!));
      continue;
    }
    const selectors = [`.${styleClassName(style.id)}:not(#\\#)`];
    if (v2 && role && (STYLE_DEFAULT_ROLE_CLASSES as readonly string[]).includes(role) && !defaultRoles.has(role)) {
      defaultRoles.add(role);
      selectors.push(`.tr-role-${role}:not(#\\#)`);
    }
    rules.push(...styleRules(style, selectors, opts.breakpoints));
  }
  const root: string[] = [];
  pushRoot('base', ON_COLOR_TOKENS.map(token => `--color-${token.replace('_', '-')}:${onColorValue(token, opts.colors, renderVersion)}`));
  if (rootByBp.get('base')?.length) root.push(`:root{${rootByBp.get('base')!.join(';')}}`);
  // Zero specificity, so a site's own values still win.
  if (v2 || explicit.has('on_primary')) root.push(`:where(:root){--color-primary-fg:var(--color-on-primary)}`);
  // An explicit on_secondary also reaches secondary buttons before version 3 defines the token.
  if (renderVersion < 3 && explicit.has('on_secondary')) root.push(`:where(:root){--color-secondary-fg:var(--color-on-secondary)}`);
  // Version 3: theme tokens blocks reference but no version defined, derived
  // from the palette instead of each block's hard-coded fallback grey.
  if (renderVersion >= 3) root.push(`:where(:root){--color-bg:var(--color-background);--color-bg-subtle:var(--color-surface);--color-border:color-mix(in srgb,var(--color-text) 18%,var(--color-background));--color-secondary-fg:var(--color-on-secondary)}`);
  for (const bp of STYLE_BREAKPOINTS) if (rootByBp.get(bp)?.length) root.push(`${media(bp)}{:root{${rootByBp.get(bp)!.join(';')}}}`);
  return [...root, ...rules].join('\n');
}

/** Styles a block of the given kind may select, for editor pickers. */
export function stylesForTarget(styles: readonly SiteStyle[] | undefined, target: StyleTarget): SiteStyle[] {
  return (styles ?? []).filter(style => !(STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role ?? '') && style.targets.includes(target));
}

// ── Standard styles ─────────────────────────────────────────────────────

/**
 * The default library every new site starts with. Sizes cover phones
 * (base), tablets and desktops; colours reference the site palette so a new
 * brand colour flows through. Text colours meet WCAG AA on the default
 * background.
 */
export const STANDARD_STYLES: readonly SiteStyle[] = [
  { id: 'body', name: 'Body text', role: 'body', targets: [], base: { size: 'md', line_height: 'relaxed', color: 'text' } },
  ...(['3xl','2xl','xl','lg','md','sm'] as const).map((size, i): SiteStyle => ({ id: `h${i+1}`, name: `Heading ${i+1}`, role: `h${i+1}` as StyleElementRole, targets: [], base: { size, weight: i < 2 ? 700 : 600, line_height: i < 2 ? 'tight' : 'snug', space_before: '1em', space_after: '0.5em' } })),
  { id: 'link', name: 'Link', role: 'link', targets: [], base: { color: 'primary', decoration: 'underline' } },
  { id: 'lead', name: 'Lead', role: 'lead', targets: ['text'], description: 'Introductory paragraph.', base: { size: 'lg', line_height: 'normal' } },
  { id: 'eyebrow', name: 'Eyebrow', role: 'eyebrow', targets: ['text', 'heading'], base: { size: 'sm', weight: 700, line_height: 'snug', letter_spacing: '0.12em', transform: 'uppercase', color: 'primary', space_after: 'sm' } },
  { id: 'small', name: 'Small text', role: 'small', targets: ['text', 'list'], base: { size: 'sm', line_height: 'normal', color: 'text_light' } },
  { id: 'quote', name: 'Quote', role: 'quote', targets: ['text'], base: { size: 'lg', line_height: 'normal', italic: true, padding: 'none none none md', border: { width: '3px', style: 'solid', color: 'primary', sides: 'left' } } },
  { id: 'button', name: 'Button', role: 'button', targets: ['button'], description: 'Primary call to action.', base: { background: 'primary', color: 'on_primary', weight: 600, padding: '0.75rem 1.25rem', radius: '0.5rem', decoration: 'none' } },
  { id: 'button-secondary', name: 'Secondary button', role: 'button_secondary', targets: ['button'], description: 'Secondary action next to a primary button.', base: { background: 'transparent', color: 'primary', weight: 600, padding: '0.6875rem 1.1875rem', radius: '0.5rem', decoration: 'none', border: { width: '1px', style: 'solid', color: 'primary' } } },
  { id: 'section', name: 'Section', role: 'section', targets: ['container'], description: 'Vertical rhythm for a page section.', base: { padding: 'xl lg' } },
];

/** The style library a newly created site starts with. */
export function newSiteStyles(): SiteStyle[] {
  return STANDARD_STYLES.map(style => structuredClone(style));
}
