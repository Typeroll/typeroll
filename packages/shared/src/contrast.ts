/**
 * Text contrast: APCA and WCAG 2.
 *
 * APCA (Accessible Perceptual Contrast Algorithm) is implemented from
 * APCA-W3 0.0.98G-4g, the constants and formula of the reference library
 * `apca-w3` 0.1.9 (Myndex). It returns a signed lightness contrast, Lc:
 * positive for dark text on a light background, negative for light text on
 * a dark background. Unlike the WCAG 2 ratio it models how bright colours
 * and polarity are perceived, so it does not overrate dark text on mid-dark
 * saturated colours (#111827 on #00a19c is WCAG 2 5.56:1 but Lc 44; white on
 * it is 3.19:1 but Lc 63.9).
 *
 * Which Lc a text needs depends on its use, size and weight. The levels
 * below follow the APCA Readability Criterion (ARC) Bronze level and the
 * APCA size and weight guidance; see `requiredContrast` and
 * docs/plans/design-system-and-render-versions.md ("Text contrast").
 */

export type Rgba = [number, number, number, number];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parse a hex or rgb()/rgba() colour. Null for anything else (tokens, hsl(), keywords). */
export function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null;
  const v = value.trim();
  if (HEX.test(v)) {
    let hex = v.slice(1);
    if (hex.length <= 4) hex = [...hex].map(c => c + c).join('');
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
  }
  return null;
}

// ── WCAG 2 ──────────────────────────────────────────────────────────────

function relativeLuminance([r, g, b]: Rgba): number {
  const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio, compositing a translucent foreground over the background. Null when unknown. */
export function contrastRatio(foreground: string | undefined, background: string | undefined): number | null {
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  if (!bg || !fg || bg[3] < 1) return null;
  const mix = (i: number) => fg[i] * fg[3] + bg[i] * (1 - fg[3]);
  const blended: Rgba = [mix(0), mix(1), mix(2), 1];
  const [a, b] = [relativeLuminance(blended), relativeLuminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ── APCA-W3 0.0.98G-4g ─────────────────────────────────────────────────

/** APCA-W3 0.0.98G-4g constants (apca-w3 0.1.9, `SA98G`). */
const SA98G = {
  mainTRC: 2.4,
  sRco: 0.2126729, sGco: 0.7151522, sBco: 0.0721750,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414,
  scaleBoW: 1.14, scaleWoB: 1.14,
  loBoWoffset: 0.027, loWoBoffset: 0.027,
  deltaYmin: 0.0005, loClip: 0.1,
} as const;

/** APCA screen luminance of an 8-bit sRGB colour (`sRGBtoY`). */
export function apcaLuminance([r, g, b]: readonly number[]): number {
  const linear = (channel: number) => (channel / 255) ** SA98G.mainTRC;
  return SA98G.sRco * linear(r) + SA98G.sGco * linear(g) + SA98G.sBco * linear(b);
}

/**
 * APCA lightness contrast (`APCAcontrast`) of text luminance on background
 * luminance. Polarity matters: positive for dark text on a light background,
 * negative for light text on a dark one; 0 for invalid input or near-equal
 * luminance.
 */
export function apcaLc(textY: number, backgroundY: number): number {
  if (!Number.isFinite(textY) || !Number.isFinite(backgroundY) || Math.min(textY, backgroundY) < 0 || Math.max(textY, backgroundY) > 1.1) return 0;
  const clampBlack = (y: number) => y > SA98G.blkThrs ? y : y + (SA98G.blkThrs - y) ** SA98G.blkClmp;
  const txt = clampBlack(textY);
  const bg = clampBlack(backgroundY);
  if (Math.abs(bg - txt) < SA98G.deltaYmin) return 0;
  if (bg > txt) {
    const sapc = (bg ** SA98G.normBG - txt ** SA98G.normTXT) * SA98G.scaleBoW;
    return sapc < SA98G.loClip ? 0 : (sapc - SA98G.loBoWoffset) * 100;
  }
  const sapc = (bg ** SA98G.revBG - txt ** SA98G.revTXT) * SA98G.scaleWoB;
  return sapc > -SA98G.loClip ? 0 : (sapc + SA98G.loWoBoffset) * 100;
}

/**
 * APCA Lc of a text colour on an opaque background (`calcAPCA`). A
 * translucent text colour is blended over the background first, with the
 * channels rounded as the reference implementation does. Null when either
 * colour is unknown or the background is translucent.
 */
export function apcaContrast(text: string | undefined, background: string | undefined): number | null {
  const bg = parseColor(background);
  const fg = parseColor(text);
  if (!bg || !fg || bg[3] < 1) return null;
  const alpha = Math.min(Math.max(fg[3], 0), 1);
  const blended = alpha < 1 ? [0, 1, 2].map(i => Math.min(Math.round(bg[i] * (1 - alpha) + fg[i] * alpha), 255)) : fg.slice(0, 3);
  return apcaLc(apcaLuminance(blended), apcaLuminance(bg));
}

// ── Required contrast by use, size and weight ───────────────────────────

/**
 * How a text is read:
 * - `body`: fluent reading, a block or column of running text (body text,
 *   lead, quote, links in text, list items).
 * - `sub_fluent`: secondary text with relaxed reading needs (notes, captions,
 *   fine print): APCA allows Lc 15 less than body text, never below Lc 40.
 * - `content`: text that is read but is not body text (headings, eyebrows,
 *   buttons, tabs, labels).
 */
export type TextUse = 'body' | 'sub_fluent' | 'content';

export interface TextSpec {
  use: TextUse;
  /** Font size in CSS px; unknown sizes count as 16px. */
  px?: number | null;
  /** Font weight 100–900; unknown weights count as 400. */
  weight?: number | null;
}

export interface RequiredContrast {
  /** Minimum APCA |Lc|. */
  lc: number;
  /** Minimum WCAG 2 ratio (AA). */
  wcag: number;
  /** What the level is for, e.g. "16px/600 non-body text". */
  label: string;
}

const LEVELS = [45, 60, 75, 90] as const;
const stricter = (lc: number) => LEVELS.find(level => level > lc) ?? lc;

/**
 * The contrast a text needs.
 *
 * APCA (ARC Bronze, with the size and weight minimums of the APCA guidance):
 *
 * | Text                                                        | Lc |
 * | ----------------------------------------------------------- | -- |
 * | Body text                                                    | 75 |
 * | Sub-fluent text (notes, captions, fine print)                | 60 |
 * | Non-body text ≥ 36px, or ≥ 24px at weight 700+               | 45 |
 * | Non-body text ≥ 16px at 600+, ≥ 21px at 500, ≥ 24px at 400   | 60 |
 * | Other non-body text (smaller or lighter)                     | 75 |
 *
 * Body and sub-fluent text below 14px, and any text at weight 300 or
 * lighter, needs the next level (Lc +15, up to 90).
 *
 * WCAG 2 AA: 3:1 for large text (≥ 24px, or ≥ 18.66px at 700+), else 4.5:1.
 */
export function requiredContrast(spec: TextSpec): RequiredContrast {
  const px = spec.px ?? 16;
  const weight = spec.weight ?? 400;
  const thin = weight <= 300;
  const size = `${Math.round(px * 100) / 100}px/${weight}`;
  const wcag = px >= 24 || (px >= 18.66 && weight >= 700) ? 3 : 4.5;
  if (spec.use === 'body' || spec.use === 'sub_fluent') {
    let lc = thin || px < 14 ? 90 : 75;
    if (spec.use === 'sub_fluent') lc = Math.max(lc - 15, 40);
    return { lc, wcag, label: `${size} ${spec.use === 'body' ? 'body text' : 'secondary text'}` };
  }
  const w = thin ? 400 : weight;
  let lc = px >= 36 || (px >= 24 && w >= 700) ? 45
    : (px >= 16 && w >= 600) || (px >= 21 && w >= 500) || px >= 24 ? 60
    : 75;
  if (thin) lc = stricter(lc);
  return { lc, wcag, label: `${size} non-body text` };
}

export interface TextContrast {
  text: string;
  background: string;
  /** Signed APCA Lc. */
  lc: number;
  /** WCAG 2 ratio. */
  wcag: number;
  required: RequiredContrast;
  /** Meets the APCA level. Lc is compared rounded to a whole number. */
  apca_pass: boolean;
  /** Meets WCAG 2 AA. */
  wcag_pass: boolean;
}

/** Both measures of a text colour on a background, against what the text needs. Null when a colour is unknown. */
export function textContrast(text: string | undefined, background: string | undefined, spec: TextSpec): TextContrast | null {
  const lc = apcaContrast(text, background);
  const wcag = contrastRatio(text, background);
  if (lc === null || wcag === null || !text || !background) return null;
  const required = requiredContrast(spec);
  return {
    text, background, lc, wcag, required,
    apca_pass: Math.round(Math.abs(lc)) >= required.lc,
    wcag_pass: wcag >= required.wcag,
  };
}

/** "APCA Lc 63.9, WCAG 2 3.19:1": both measures, Lc as a magnitude. */
export function formatContrast(measure: Pick<TextContrast, 'lc' | 'wcag'>): string {
  return `APCA Lc ${Math.abs(measure.lc).toFixed(1)}, WCAG 2 ${measure.wcag.toFixed(2)}:1`;
}

/** Near-black text used for the derived on_* colours. */
export const ON_LIGHT = '#111827';
/** White text used for the derived on_* colours. */
export const ON_DARK = '#ffffff';

/** Near-black or white, whichever has the higher WCAG 2 ratio on `background` (render versions 1–7). */
export function onColorWcag(background: string | undefined): string {
  const light = contrastRatio(ON_LIGHT, background) ?? 0;
  const dark = contrastRatio(ON_DARK, background) ?? 0;
  return dark >= light ? ON_DARK : ON_LIGHT;
}

/** Near-black or white, whichever has the higher APCA |Lc| on `background` (render version 8). */
export function onColorApca(background: string | undefined): string {
  const light = Math.abs(apcaContrast(ON_LIGHT, background) ?? 0);
  const dark = Math.abs(apcaContrast(ON_DARK, background) ?? 0);
  return dark >= light ? ON_DARK : ON_LIGHT;
}
