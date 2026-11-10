/**
 * Site fonts: roles, the per-site font library, font services, what a site
 * uses, and the plan a publication loads.
 *
 * A site chooses a family per role (`SiteSettings.fonts`). Styles and blocks
 * choose a role, never a family, so a template follows the site it is
 * inserted into. From render version 15 a publication loads only the weights
 * and italics the site uses (`collectFontUsage` → `planSiteFonts`); a variable
 * family loads as one file covering the needed range. From version 17 that
 * includes the weights written in custom CSS and in CSS inside blocks.
 * Versions 1–14 keep the fixed 400–700 Google request.
 *
 * Family sources, in order: the site's uploaded fonts (Fonts library), a font
 * service (Adobe Fonts kit, Bunny Fonts or Fontshare stylesheet, which load
 * from their CDN), the system stack, and otherwise Google Fonts (self-hosted
 * by default).
 */
import type { Block, BlockType } from './types.js';
import { routeOverrideEntries } from './route-overrides.js';
import { blockOutputForVersion } from './render-version.js';
import type { SiteStyle, StyleProps } from './site-styles.js';
import { FONT_CATALOG, type CatalogFont } from './font-catalog.js';
import type { FallbackOverrides } from './font-file.js';

export const SITE_FONT_ROLES = ['heading', 'body', 'mono', 'display', 'accent'] as const;
export type SiteFontRole = typeof SITE_FONT_ROLES[number];
export const isSiteFontRole = (value: unknown): value is SiteFontRole => typeof value === 'string' && (SITE_FONT_ROLES as readonly string[]).includes(value);

/** First render version that loads only the weights in use, and has the display and accent roles. */
export const FONT_PLAN_RENDER_VERSION = 15;

export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const isWeight = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 900 && value % 100 === 0;

// ── Font services ─────────────────────────────────────────────────────────

export type FontServiceProvider = 'adobe' | 'bunny' | 'fontshare';
/**
 * A font service whose stylesheet loads from its own CDN. Adobe Fonts'
 * licence does not allow self-hosting, so its kit always loads from Adobe.
 * `families` are the names the stylesheet defines, which the roles can use.
 */
export type FontService =
  | { provider: 'adobe'; kit: string; families: string[] }
  | { provider: 'bunny' | 'fontshare'; url: string; families: string[] };

export const MAX_FONT_SERVICES = 4;
export const ADOBE_KIT_PATTERN = /^[a-z0-9]{5,12}$/;
const SERVICE_HOSTS: Record<'bunny' | 'fontshare', string> = { bunny: 'fonts.bunny.net', fontshare: 'api.fontshare.com' };

/** The stylesheet a service loads. */
export function fontServiceStylesheet(service: FontService): string {
  return service.provider === 'adobe' ? `https://use.typekit.net/${service.kit}.css` : service.url;
}

/** The provider a pasted stylesheet URL belongs to, or null. */
export function fontServiceProvider(url: string): 'bunny' | 'fontshare' | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname === SERVICE_HOSTS.bunny && /^\/css2?$/.test(parsed.pathname)) return 'bunny';
    if (parsed.hostname === SERVICE_HOSTS.fontshare && /^\/v2\/css$/.test(parsed.pathname)) return 'fontshare';
  } catch { /* not a URL */ }
  return null;
}

/** Family names a service stylesheet defines (`font-family` in its `@font-face` rules). */
export function serviceStylesheetFamilies(css: string): string[] {
  const names = new Set<string>();
  for (const rule of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const match = /font-family\s*:\s*(['"]?)([^;'"}]+)\1/i.exec(rule);
    const family = match?.[2]?.trim();
    if (family && FAMILY_PATTERN.test(family)) names.add(family);
  }
  return [...names];
}

// ── The per-site font library ─────────────────────────────────────────────

/**
 * One uploaded font file in the site's Fonts library (not the media
 * library). The served file is always WOFF2; a TTF, OTF or WOFF upload is
 * converted and its original kept.
 */
export interface SiteFontFile {
  id: string;
  family: string;
  /** A weight, or the range a variable file covers. */
  weight: number | [number, number];
  style: 'normal' | 'italic';
  /** The served file. */
  file: { format: 'woff2'; bytes: number; sha256: string; key: string };
  /** The uploaded file when it was converted. */
  original?: { format: 'ttf' | 'otf' | 'woff'; bytes: number; sha256: string; key: string; name?: string };
  /** Metrics read from the file, for its metric-matched fallback. */
  metrics?: import('./font-file.js').FontMetrics;
  category?: 'sans' | 'serif';
  /** The uploader confirmed the licence allows use on this website. */
  licence: { confirmed: true; by: string; at: string; note?: string };
  created_at: string;
}

export const MAX_SITE_FONT_FILES = 60;
export const MAX_FONT_UPLOAD_BYTES = 10 * 1024 * 1024;
export const FONT_UPLOAD_FORMATS = ['woff2', 'woff', 'ttf', 'otf'] as const;

/** Weights a library file covers as [min, max]. */
export const fontFileWeightRange = (file: Pick<SiteFontFile, 'weight'>): [number, number] => Array.isArray(file.weight) ? file.weight : [file.weight, file.weight];

// ── Settings validation ───────────────────────────────────────────────────

/** Family names are data: letters, digits, spaces and a few punctuation marks. */
export const FAMILY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.&+-]{0,79}$/u;

/** Errors in the font keys added with the font library (roles, load, services). */
export function siteFontsErrors(fonts: unknown): string[] {
  if (fonts == null) return [];
  if (typeof fonts !== 'object' || Array.isArray(fonts)) return ['fonts must be an object'];
  const f = fonts as Record<string, unknown>;
  const errors: string[] = [];
  for (const role of SITE_FONT_ROLES) {
    const value = f[role];
    if (value === undefined || (value === null && role !== 'heading' && role !== 'body')) continue;
    if (typeof value !== 'string' || !FAMILY_PATTERN.test(value.trim())) errors.push(`fonts.${role} must be a font family name (letters, digits, spaces; at most 80 characters)`);
  }
  if (f.load !== undefined && f.load !== null) {
    if (typeof f.load !== 'object' || Array.isArray(f.load)) errors.push('fonts.load must be an object keyed by role');
    else for (const [role, spec] of Object.entries(f.load as Record<string, unknown>)) {
      if (!isSiteFontRole(role)) { errors.push(`fonts.load.${role} is not a font role (${SITE_FONT_ROLES.join(', ')})`); continue; }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { errors.push(`fonts.load.${role} must be { weights?, italic? }`); continue; }
      for (const [key, list] of Object.entries(spec as Record<string, unknown>)) {
        if (key !== 'weights' && key !== 'italic') errors.push(`fonts.load.${role}.${key} is not allowed (weights, italic)`);
        else if (!Array.isArray(list) || list.length > 9 || !list.every(isWeight)) errors.push(`fonts.load.${role}.${key} must list weights 100–900 in steps of 100`);
      }
    }
  }
  if (f.services !== undefined && f.services !== null) {
    if (!Array.isArray(f.services)) errors.push('fonts.services must be a list');
    else {
      if (f.services.length > MAX_FONT_SERVICES) errors.push(`fonts.services allows at most ${MAX_FONT_SERVICES} services`);
      f.services.forEach((service, index) => {
        const where = `fonts.services[${index}]`;
        if (!service || typeof service !== 'object') { errors.push(`${where} must be an object`); return; }
        const s = service as Record<string, unknown>;
        if (s.provider === 'adobe') {
          if (typeof s.kit !== 'string' || !ADOBE_KIT_PATTERN.test(s.kit)) errors.push(`${where}.kit must be an Adobe Fonts web project ID (5–12 lowercase letters and digits)`);
        } else if (s.provider === 'bunny' || s.provider === 'fontshare') {
          if (typeof s.url !== 'string' || fontServiceProvider(s.url) !== s.provider) errors.push(`${where}.url must be a ${s.provider === 'bunny' ? 'https://fonts.bunny.net/css' : 'https://api.fontshare.com/v2/css'} stylesheet URL`);
        } else errors.push(`${where}.provider must be adobe, bunny or fontshare`);
        if (!Array.isArray(s.families) || s.families.length > 40 || !s.families.every(name => typeof name === 'string' && FAMILY_PATTERN.test(name))) errors.push(`${where}.families must list the stylesheet's family names (at most 40)`);
        for (const key of Object.keys(s)) if (!['provider', 'kit', 'url', 'families'].includes(key)) errors.push(`${where}.${key} is not allowed`);
      });
    }
  }
  return errors;
}

// ── The catalog ───────────────────────────────────────────────────────────

const CATALOG_BY_NAME = new Map(FONT_CATALOG.map(font => [font.family.toLowerCase(), font]));
/** The catalog entry for a family name (case-insensitive), or undefined. */
export function catalogFont(family: string | undefined | null): CatalogFont | undefined {
  return family ? CATALOG_BY_NAME.get(family.trim().toLowerCase()) : undefined;
}

export interface FontSearchFilters {
  query?: string;
  category?: CatalogFont['category'] | CatalogFont['category'][];
  /** Only variable families. */
  variable?: boolean;
  /** Only families with italics. */
  italic?: boolean;
  /** Only families with the extended Latin subset (Polish, Czech, Turkish…). Swedish, Norwegian, Danish, Finnish and German are covered by every family. */
  latin_ext?: boolean;
  /** Only families with at least this many weights. */
  min_weights?: number;
  limit?: number;
}

/** Search the catalog: exact name first, then names starting with the query, then names containing it. */
export function searchFontCatalog(filters: FontSearchFilters = {}): CatalogFont[] {
  const query = (filters.query ?? '').trim().toLowerCase();
  const categories = filters.category ? (Array.isArray(filters.category) ? filters.category : [filters.category]) : null;
  const rank = (font: CatalogFont) => {
    if (!query) return 0;
    const name = font.family.toLowerCase();
    return name === query ? 0 : name.startsWith(query) ? 1 : name.split(/\s+/).some(word => word.startsWith(query)) ? 2 : name.includes(query) ? 3 : -1;
  };
  return FONT_CATALOG
    .filter(font => (!categories || categories.includes(font.category))
      && (!filters.variable || !!font.variable)
      && (!filters.italic || !!font.italic?.length)
      && (!filters.latin_ext || !!font.latin_ext)
      && (!filters.min_weights || font.weights.length >= filters.min_weights))
    .map(font => ({ font, rank: rank(font) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(1, Math.min(filters.limit ?? 50, FONT_CATALOG.length)))
    .map(entry => entry.font);
}

/** Sample text for font previews, in the site's language. */
export function fontSampleText(language: string | undefined): { heading: string; body: string } {
  const base = String(language ?? 'en').toLowerCase().split('-')[0];
  const samples: Record<string, { heading: string; body: string }> = {
    sv: { heading: 'Flygande bäckasiner söka hwila', body: 'Flygande bäckasiner söka hwila på mjuka tuvor. Öppet måndag–fredag 09–17, ÅÄÖ åäö 0123456789.' },
    nb: { heading: 'Vår sære Zulu fra badeøya', body: 'Vår sære Zulu fra badeøya spilte jo whist og quickstep i min taxi. ÆØÅ æøå 0123456789.' },
    no: { heading: 'Vår sære Zulu fra badeøya', body: 'Vår sære Zulu fra badeøya spilte jo whist og quickstep i min taxi. ÆØÅ æøå 0123456789.' },
    da: { heading: 'Høj bly gom vandt fræk sexquiz', body: 'Høj bly gom vandt fræk sexquiz på wc. Åbent mandag–fredag 9–17. ÆØÅ æøå 0123456789.' },
    fi: { heading: 'Törkylempijävongahdus', body: 'Charles Darwin jammaili Åken hevixylofonilla Qatarin yöpub Zeligissä. ÄÖ äö 0123456789.' },
    de: { heading: 'Zwölf Boxkämpfer jagen Viktor', body: 'Victor jagt zwölf Boxkämpfer quer über den großen Sylter Deich. ÄÖÜ äöüß 0123456789.' },
    en: { heading: 'The quick brown fox jumps', body: 'The quick brown fox jumps over the lazy dog. Open Monday–Friday 9–5, 0123456789.' },
  };
  return samples[base] ?? samples.en;
}

// ── Role families ─────────────────────────────────────────────────────────

type FontSettings = {
  heading?: string; body?: string; mono?: string; display?: string; accent?: string;
  delivery?: unknown;
  load?: Partial<Record<SiteFontRole, { weights?: number[]; italic?: number[] }>>;
  services?: FontService[];
};

/**
 * The family each role uses. Heading and body default to Inter; mono has no
 * webfont unless set; display falls back to heading and accent to body.
 */
export function fontRoleFamilies(fonts: FontSettings | undefined): Record<SiteFontRole, string | undefined> {
  const heading = fonts?.heading || 'Inter', body = fonts?.body || 'Inter';
  return { heading, body, mono: fonts?.mono || undefined, display: fonts?.display || heading, accent: fonts?.accent || body };
}

// ── Usage ─────────────────────────────────────────────────────────────────

export interface FontRoleUsage { weights: number[]; italic: number[] }
export type FontUsage = Record<SiteFontRole, FontRoleUsage>;

type FontBlockType = Pick<BlockType, 'schema'> & Partial<Pick<BlockType, 'origin' | 'template' | 'styles' | 'render_versions'>>;
type BlockTypeLookup = ReadonlyMap<string, FontBlockType> | ((id: string) => FontBlockType | undefined);

export interface FontUsageInput {
  styles?: readonly SiteStyle[] | null;
  /** Every block tree of the site: page bodies, partials, global blocks and templates in use. */
  blocks?: Iterable<Block | null | undefined>;
  /** Block types, for field defaults (a heading's default weight) and, from `CSS_FONT_USAGE_RENDER_VERSION`, the CSS in the site's own types' templates and styles. */
  blockTypes?: BlockTypeLookup;
  /** The site's stylesheets: its custom CSS and the pages' own. Counted from `CSS_FONT_USAGE_RENDER_VERSION`. */
  css?: Iterable<string | null | undefined>;
  /** The site's render version. From `CSS_FONT_USAGE_RENDER_VERSION` weights written in CSS count too. */
  renderVersion?: number;
}

/** First render version whose font plan counts the weights and italics written in CSS. */
export const CSS_FONT_USAGE_RENDER_VERSION = 17;

const HEADING_ELEMENTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const WEIGHT_KEY = /(?:^|_)font_weight$/;
const BOLD = /<(?:strong|b)[\s>]/i, ITALIC = /<(?:em|i)[\s>]/i, HEADING_HTML = /<h[1-6][\s>]/i;

// ── Weights written in CSS ────────────────────────────────────────────────
//
// A small tokenizer, not a CSS parser: it only has to find font-weight,
// font-style and the font shorthand, and which role's font they apply to.
// Reading too much costs an extra weight; missing one makes the browser
// synthesize or snap it.

const CSS_FONT_HINT = /font(?:-weight|-style)?\s*:/i;
const FONT_VARIABLE = /var\(\s*--font-(heading|body|mono|display|accent)(?![\w-])/gi;
const HEADING_TYPE = /(?:^|[\s>+~(,])h[1-6](?![\w-])/gi;
const GROUPING_AT_RULE = /^@(?:media|supports|layer|container|document|scope|starting-style)\b/i;
const FONT_SIZE_TOKEN = /^(?:(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z]+|%)|0|(?:xx?x?-)?(?:small|large)|medium|smaller|larger)(?:\/|$)|(?:calc|clamp|min|max)\()/i;
const ANGLE_TOKEN = /^[+-]?[\d.]+(?:deg|g?rad|turn)$/i;

/** A font-weight value as a planner weight: 100–900 in steps of 100, or undefined for relative keywords and variables. */
function cssWeight(value: string): number | undefined {
  const v = value.replace(/!\s*important\s*$/i, '').trim().toLowerCase();
  if (v === 'bold') return 700;
  if (v === 'normal') return 400;
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(v)) return undefined;
  const n = Number(v);
  if (n < 1 || n > 1000) return undefined;
  return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
}

/** Whitespace-separated tokens outside parentheses. */
function cssTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0, current = '';
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) { if (current) tokens.push(current); current = ''; }
    else current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** The weight and style a `font` shorthand sets, or null when it cannot be read (`inherit`, a variable, a system font). */
function fontShorthand(value: string): { weight?: number; italic: boolean } | null {
  let weight: number | undefined, italic = false, relative = false;
  for (const token of cssTokens(value.replace(/!\s*important\s*$/i, '').trim())) {
    if (ANGLE_TOKEN.test(token)) continue;
    if (FONT_SIZE_TOKEN.test(token)) return { weight: weight ?? (relative ? undefined : 400), italic };
    const lower = token.toLowerCase();
    if (lower.startsWith('var(')) return null;
    if (lower === 'italic' || lower === 'oblique') italic = true;
    else if (lower === 'bolder' || lower === 'lighter') relative = true;
    else if (lower !== 'normal') weight = cssWeight(lower) ?? weight;
  }
  return null;
}

function cssDeclarations(body: string): Array<{ property: string; value: string }> {
  return body.split(';').flatMap(part => {
    const colon = part.indexOf(':');
    if (colon < 0) return [];
    const property = part.slice(0, colon).trim().toLowerCase(), value = part.slice(colon + 1).trim();
    return property && value ? [{ property, value }] : [];
  });
}

/** Style rules with their own declarations, through grouping at-rules and nesting. Other at-rules (@font-face, @keyframes) are skipped. */
function cssStyleRules(css: string, parent = '', out: Array<{ selector: string; declarations: string }> = [], depth = 0) {
  if (depth > 8) return out;
  let i = 0, declarations = '';
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) { declarations += css.slice(i); break; }
    let level = 1, j = open + 1;
    for (; j < css.length && level > 0; j++) { if (css[j] === '{') level++; else if (css[j] === '}') level--; }
    const head = css.slice(i, open).replace(/[^;]*\}/g, '');
    const cut = head.lastIndexOf(';');
    declarations += head.slice(0, cut + 1);
    const prelude = head.slice(cut + 1).trim();
    const inner = css.slice(open + 1, level ? j : j - 1);
    if (GROUPING_AT_RULE.test(prelude)) cssStyleRules(inner, parent, out, depth + 1);
    else if (prelude && !prelude.startsWith('@')) {
      const selector = !parent ? prelude : prelude.includes('&') ? prelude.replace(/&/g, parent) : `${parent} ${prelude}`;
      cssStyleRules(inner, selector, out, depth + 1);
    }
    i = j;
  }
  if (parent && declarations.trim()) out.push({ selector: parent, declarations });
  return out;
}

/**
 * The roles a selector's text sets: heading for heading elements (and what
 * they contain), otherwise body and heading, since the weight can be
 * inherited by either font.
 */
function selectorRoles(selector: string): SiteFontRole[] {
  for (const part of selector.split(',')) {
    const matches = [...part.matchAll(HEADING_TYPE)];
    const last = matches[matches.length - 1];
    if (!last || /[+~]/.test(part.slice(last.index! + last[0].length))) return ['body', 'heading'];
  }
  return ['heading'];
}

/**
 * Which weights and italics each role needs, from the site's styles, every
 * block's weight fields and defaults, and bold and italic text in rich text.
 * From render version 17 also the weights written in CSS: the site's and the
 * pages' custom CSS, and CSS inside block data (`<style>`, `style=""`, a
 * block's own custom CSS). Body always needs 400. Headings without a styled
 * weight are bold (700).
 */
export function collectFontUsage(input: FontUsageInput): FontUsage {
  const sets = Object.fromEntries(SITE_FONT_ROLES.map(role => [role, { weights: new Set<number>(), italic: new Set<number>() }])) as Record<SiteFontRole, { weights: Set<number>; italic: Set<number> }>;
  const add = (role: SiteFontRole, weight: number, italic = false) => { if (isWeight(weight)) (italic ? sets[role].italic : sets[role].weights).add(weight); };
  sets.body.weights.add(400);

  const countCss = (input.renderVersion ?? 0) >= CSS_FONT_USAGE_RENDER_VERSION;
  /** One declaration block: its weights go to the font variables it names, otherwise to `roles`. */
  const cssBlock = (declarations: string, roles: SiteFontRole[]) => {
    const named = new Set<SiteFontRole>(), weights: number[] = [];
    let italic = false;
    for (const { property, value } of cssDeclarations(declarations)) {
      if (property === 'font-family' || property === 'font') for (const match of value.matchAll(FONT_VARIABLE)) named.add(match[1].toLowerCase() as SiteFontRole);
      if (property === 'font-weight') { const weight = cssWeight(value); if (weight) weights.push(weight); }
      else if (property === 'font-style') { if (/^(?:italic|oblique)\b/i.test(value)) italic = true; }
      else if (property === 'font') {
        const font = fontShorthand(value);
        if (font?.weight) weights.push(font.weight);
        if (font?.italic) italic = true;
      }
    }
    for (const role of named.size ? [...named] : roles) {
      for (const weight of weights) add(role, weight);
      if (italic) for (const weight of weights.length ? weights : [role === 'heading' ? 700 : 400]) add(role, weight, true);
    }
  };
  const stylesheet = (css: string) => {
    for (const rule of cssStyleRules(css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' '))) cssBlock(rule.declarations, selectorRoles(rule.selector));
  };
  /** CSS in a block's text: `<style>` elements and `style` attributes in HTML, a stylesheet, or bare declarations (in the block's role). */
  const cssText = (value: string, role: SiteFontRole) => {
    if (/<[a-z!/]/i.test(value)) {
      for (const match of value.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)) stylesheet(match[1]);
      for (const match of value.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) cssBlock((match[1] ?? match[2]).replace(/&quot;|&#0*34;/g, '"').replace(/&#0*39;|&apos;/g, "'"), [role]);
    } else if (value.includes('{')) stylesheet(value);
    else if (/^\s*[a-z-]+\s*:/i.test(value)) cssBlock(value, [role]);
  };
  if (countCss) for (const css of input.css ?? []) if (typeof css === 'string' && CSS_FONT_HINT.test(css)) stylesheet(css);

  // Styles: element roles style every matching element; class styles a chosen block.
  const styledHeadings = new Set<string>();
  for (const style of input.styles ?? []) {
    const element = style.role && (HEADING_ELEMENTS.has(style.role) ? 'heading' : style.role === 'body' || style.role === 'link' ? 'body' : null);
    const variants: StyleProps[] = [style.base ?? {}, ...Object.values(style.at ?? {}).map(props => ({ ...style.base, ...props }))];
    for (const props of variants) {
      const font = props.font && props.font !== 'inherit' ? [props.font] : element ? [element] : ['body', 'heading'] as SiteFontRole[];
      const weight = props.weight ?? (element === 'heading' ? 700 : undefined);
      for (const role of font as SiteFontRole[]) {
        if (weight) add(role, weight);
        if (props.italic) add(role, weight ?? (role === 'heading' ? 700 : 400), true);
      }
    }
    if (style.role && HEADING_ELEMENTS.has(style.role) && style.base?.weight) styledHeadings.add(style.role);
  }
  if (styledHeadings.size < HEADING_ELEMENTS.size) add('heading', 700);

  const lookup = (id: string) => typeof input.blockTypes === 'function' ? input.blockTypes(id) : input.blockTypes?.get(id);
  const blockRole = (block: Block, schemaFont: unknown): SiteFontRole => {
    const chosen = block.data?.font ?? schemaFont;
    if (isSiteFontRole(chosen)) return chosen;
    return /heading/.test(block.type) ? 'heading' : 'body';
  };
  const weightValues = (value: unknown, out: number[]) => {
    if (typeof value === 'number' || typeof value === 'string') { const n = Number(value); if (isWeight(n)) out.push(n); }
    else if (value && typeof value === 'object' && !Array.isArray(value)) for (const inner of Object.values(value)) weightValues(inner, out);
  };
  const scanText = (value: unknown, role: SiteFontRole, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (value.length < 4) return;
      if (countCss && CSS_FONT_HINT.test(value)) cssText(value, role);
      if (!value.includes('<')) return;
      const bold = BOLD.test(value), italic = ITALIC.test(value);
      if (bold) add(role, 700);
      if (italic) { add(role, 400, true); if (bold) add(role, 700, true); }
      if (HEADING_HTML.test(value)) add('heading', 700);
    } else if (Array.isArray(value)) for (const item of value) scanText(item, role, depth + 1);
    else if (value && typeof value === 'object') for (const inner of Object.values(value)) scanText(inner, role, depth + 1);
  };
  // The CSS a site's own block type brings, once per type in use: `<style>`
  // in its template and its styles, at the site's render version. Core types
  // are left out: their weights come from their schema defaults.
  const typeCssSeen = new Set<string>();
  const typeCss = (id: string, type: FontBlockType | undefined, role: SiteFontRole) => {
    if (!countCss || !type || type.origin === 'core' || typeCssSeen.has(id)) return;
    typeCssSeen.add(id);
    const output = blockOutputForVersion({ template: type.template, styles: type.styles, render_versions: type.render_versions }, input.renderVersion ?? 0);
    if (typeof output.template === 'string' && CSS_FONT_HINT.test(output.template)) cssText(output.template, role);
    if (typeof output.styles === 'string' && CSS_FONT_HINT.test(output.styles)) stylesheet(output.styles);
  };
  const visit = (block: Block | null | undefined, depth: number) => {
    if (!block || typeof block !== 'object' || depth > 32) return;
    // Each route's settings load the fonts they choose, like the base data.
    for (const [, override] of routeOverrideEntries(block)) visit({ id: block.id, type: block.type, data: { ...block.data, ...override } }, depth + 1);
    const type = lookup(block.type);
    const schema = type?.schema ?? [];
    const role = blockRole(block, schema.find(field => field.name === 'font')?.default);
    typeCss(block.type, type, role);
    const weights: number[] = [];
    const data = block.data ?? {};
    for (const field of schema) if (WEIGHT_KEY.test(field.name) && data[field.name] === undefined && field.default !== undefined) weightValues(field.default, weights);
    for (const [key, value] of Object.entries(data)) if (WEIGHT_KEY.test(key)) weightValues(value, weights);
    for (const override of Object.values(block.responsive ?? {})) for (const [key, value] of Object.entries(override?.data_overrides ?? {})) if (WEIGHT_KEY.test(key)) weightValues(value, weights);
    for (const weight of weights) add(role, weight);
    // Text in another role's font keeps the inherited regular weight, for
    // example tab labels set in the heading font. Without 400 the browser
    // draws them with the nearest planned weight, which looks bolder.
    if (role !== 'body' && !/heading/.test(block.type)) add(role, 400);
    if (isSiteFontRole(data.title_font)) add(data.title_font, 600);
    scanText(data, role);
    const instanceCss = block.style_overrides?.custom_css;
    if (countCss && typeof instanceCss === 'string' && CSS_FONT_HINT.test(instanceCss)) stylesheet(instanceCss);
    for (const child of block.children ?? []) visit(child, depth + 1);
    for (const slot of block.slots ?? []) for (const child of slot ?? []) visit(child, depth + 1);
  };
  for (const block of input.blocks ?? []) visit(block, 0);

  return Object.fromEntries(SITE_FONT_ROLES.map(role => [role, {
    weights: [...sets[role].weights].sort((a, b) => a - b),
    italic: [...sets[role].italic].sort((a, b) => a - b),
  }])) as FontUsage;
}

/**
 * The face CSS font matching picks for a weight among the available ones
 * (CSS Fonts 4, §5.2): 400 tries 500 first, 500 tries 400, lighter weights
 * look lighter first and bolder weights bolder first.
 */
export function matchFontWeight(wanted: number, available: readonly number[]): number | undefined {
  if (!available.length) return undefined;
  if (available.includes(wanted)) return wanted;
  const sorted = [...available].sort((a, b) => a - b);
  const below = sorted.filter(w => w < wanted).reverse(), above = sorted.filter(w => w > wanted);
  if (wanted === 400 && sorted.includes(500)) return 500;
  if (wanted === 500 && sorted.includes(400)) return 400;
  if (wanted <= 500) return below[0] ?? above[0];
  return above[0] ?? below[0];
}

// ── The plan ──────────────────────────────────────────────────────────────

export type FontSource = 'google' | 'upload' | 'service' | 'system';

export interface PlannedFamily {
  family: string;
  roles: SiteFontRole[];
  source: FontSource;
  /** Upright weights to load (for a variable family: the range ends). */
  weights: number[];
  italic: number[];
  /** A variable Google family loads one file per subset covering this range. */
  variable?: { weights?: [number, number]; italic?: [number, number] };
  /** Library files to publish (source `upload`). */
  files?: string[];
  category?: CatalogFont['category'];
  /** A metric-matched local fallback, set when the files are copied. */
  fallback?: FallbackOverrides;
}

/**
 * What a publication loads. Computed when the publication is frozen and
 * carried in its settings (`SiteSettings.font_plan`), so the renderer and
 * every build engine use the same plan without the site's other pages.
 */
export interface FontPlan {
  render_version: number;
  families: PlannedFamily[];
  /** The Google Fonts stylesheet (copied when self-hosted), or null. */
  google_css_url: string | null;
  /** Service stylesheets, loaded from their CDN. */
  service_stylesheets: string[];
  /** Same-origin file to preload: the body family's upright Latin file. */
  preload?: string;
}

export interface FontPlanOptions {
  renderVersion: number;
  /** The site's Fonts library. */
  library?: ReadonlyArray<Pick<SiteFontFile, 'id' | 'family' | 'weight' | 'style' | 'category'>>;
}

/** The system families never trigger a network request. */
const isSystem = (family: string) => ['system', 'system-ui'].includes(family.trim().toLowerCase());
const LEGACY_WEIGHTS = [400, 500, 600, 700];

/** The Google Fonts css2 parameter for one planned family. */
export function googleFamilyParameter(family: PlannedFamily): string {
  const name = encodeURIComponent(family.family);
  const upright = family.variable?.weights ? [family.variable.weights] : family.weights.map(w => [w, w] as [number, number]);
  const italic = family.variable?.italic ? [family.variable.italic] : family.italic.map(w => [w, w] as [number, number]);
  const range = ([a, b]: [number, number]) => a === b ? String(a) : `${a}..${b}`;
  if (!italic.length) return `family=${name}:wght@${upright.map(range).join(';')}`;
  return `family=${name}:ital,wght@${[...upright.map(r => `0,${range(r)}`), ...italic.map(r => `1,${range(r)}`)].join(';')}`;
}

/** The Google Fonts stylesheet for planned families, or null when there are none. */
export function googleFontsPlanUrl(families: readonly PlannedFamily[]): string | null {
  const google = families.filter(family => family.source === 'google' && (family.weights.length || family.italic.length || family.variable));
  return google.length ? `https://fonts.googleapis.com/css2?${google.map(googleFamilyParameter).join('&')}&display=swap` : null;
}

/**
 * Plan the fonts a publication loads. Before render version 15 the roles
 * heading, body and mono load from Google at 400–700 as they always have
 * (uploaded and service families are left out of that request).
 */
export function planSiteFonts(fonts: FontSettings | undefined, usage: FontUsage, options: FontPlanOptions): FontPlan {
  const v15 = options.renderVersion >= FONT_PLAN_RENDER_VERSION;
  const families = fontRoleFamilies(fonts);
  const library = options.library ?? [];
  const services = Array.isArray(fonts?.services) ? fonts!.services : [];
  const serviceFamilies = new Set(services.flatMap(service => service.families ?? []).map(name => name.toLowerCase()));
  const uploaded = new Map<string, typeof library[number][]>();
  for (const file of library) {
    const key = file.family.toLowerCase();
    uploaded.set(key, [...uploaded.get(key) ?? [], file]);
  }
  const roles: SiteFontRole[] = v15 ? [...SITE_FONT_ROLES] : ['heading', 'body', 'mono'];
  const byFamily = new Map<string, PlannedFamily>();
  for (const role of roles) {
    const family = families[role];
    if (!family || isSystem(family)) continue;
    const key = family.toLowerCase();
    // Display and accent that fall back to heading and body add no family.
    if (!v15 || role === 'heading' || role === 'body' || role === 'mono' || (role === 'display' ? fonts?.display : fonts?.accent)) {
      const source: FontSource = uploaded.has(key) ? 'upload' : serviceFamilies.has(key) ? 'service' : 'google';
      const entry = byFamily.get(key) ?? { family, roles: [], source, weights: [], italic: [] };
      entry.roles.push(role);
      byFamily.set(key, entry);
    } else {
      // The role uses another role's family: its usage counts there.
      const target = byFamily.get((role === 'display' ? families.heading : families.body)!.toLowerCase());
      if (target && !target.roles.includes(role)) target.roles.push(role);
    }
  }

  const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  for (const entry of byFamily.values()) {
    const wanted = unique(entry.roles.flatMap(role => [...usage[role]?.weights ?? [], ...fonts?.load?.[role]?.weights ?? []]));
    const wantedItalic = unique(entry.roles.flatMap(role => [...usage[role]?.italic ?? [], ...fonts?.load?.[role]?.italic ?? []]));
    if (entry.source === 'upload') {
      const files = uploaded.get(entry.family.toLowerCase())!;
      entry.category = files.find(file => file.category)?.category;
      // Every file of the family before version 15; from 15 the files covering the weights in use.
      const pick = (style: 'normal' | 'italic', want: number[]) => {
        const candidates = files.filter(file => file.style === style);
        if (!v15) return candidates;
        const chosen = new Set<typeof candidates[number]>();
        for (const weight of want) {
          const covering = candidates.find(file => { const [a, b] = fontFileWeightRange(file); return weight >= a && weight <= b; });
          if (covering) { chosen.add(covering); continue; }
          const match = matchFontWeight(weight, candidates.flatMap(file => fontFileWeightRange(file)));
          const nearest = candidates.find(file => fontFileWeightRange(file).includes(match!));
          if (nearest) chosen.add(nearest);
        }
        return [...chosen];
      };
      const upright = pick('normal', wanted.length ? wanted : [400]), italics = pick('italic', wantedItalic);
      entry.files = [...upright, ...italics].map(file => file.id);
      entry.weights = unique(upright.flatMap(file => fontFileWeightRange(file)));
      entry.italic = unique(italics.flatMap(file => fontFileWeightRange(file)));
      continue;
    }
    if (entry.source === 'service') { entry.weights = wanted; entry.italic = wantedItalic; continue; }
    const catalog = catalogFont(entry.family);
    if (catalog) { entry.family = catalog.family; entry.category = catalog.category; }
    if (!v15 || !catalog) {
      // Unknown families keep the request every version has always made.
      entry.weights = LEGACY_WEIGHTS;
      continue;
    }
    const upright = unique((wanted.length ? wanted : [400]).map(weight => matchFontWeight(weight, catalog.weights)!).filter(Boolean));
    const italic = unique(wantedItalic.map(weight => matchFontWeight(weight, catalog.italic ?? [])).filter((w): w is number => !!w));
    entry.weights = upright;
    entry.italic = italic;
    if (catalog.variable) {
      const clamp = (values: number[]): [number, number] | undefined => values.length > 1
        ? [Math.max(catalog.variable![0], values[0]), Math.min(catalog.variable![1], values[values.length - 1])] : undefined;
      const variable = { weights: clamp(upright), italic: clamp(italic) };
      if (variable.weights || variable.italic) entry.variable = Object.fromEntries(Object.entries(variable).filter(([, range]) => range)) as PlannedFamily['variable'];
    }
  }

  const planned = [...byFamily.values()];
  const legacyGoogle = planned.filter(family => family.source === 'google').map(family => family.family);
  return {
    render_version: options.renderVersion,
    families: planned,
    google_css_url: v15 ? googleFontsPlanUrl(planned)
      : legacyGoogle.length ? `https://fonts.googleapis.com/css2?${legacyGoogle.map(family => `family=${encodeURIComponent(family)}:wght@400;500;600;700`).join('&')}&display=swap` : null,
    service_stylesheets: services.map(fontServiceStylesheet),
  };
}

// ── CSS ───────────────────────────────────────────────────────────────────

const cssFamily = (value: string) => `'${value.replace(/[\\'\r\n<>;{}]/g, '')}'`;
/** The name of a family's metric-matched fallback face. */
export const fallbackFaceName = (family: string) => `${family.replace(/[\\'\r\n<>;{}]/g, '')} fallback`;

/** Metric-matched fallback faces for the planned families that have metrics (render version 15). */
export function fontFallbackFacesCss(plan: FontPlan | null | undefined): string {
  if (!plan || plan.render_version < FONT_PLAN_RENDER_VERSION) return '';
  return plan.families.filter(family => family.fallback).map(({ family, fallback }) =>
    `@font-face{font-family:${cssFamily(fallbackFaceName(family))};src:${fallback!.local.map(name => `local(${cssFamily(name)})`).join(',')};size-adjust:${fallback!.size_adjust}%;ascent-override:${fallback!.ascent}%;descent-override:${fallback!.descent}%;line-gap-override:${fallback!.line_gap}%}`,
  ).join('');
}

/** The family's own metric-matched fallback name when the plan has one. */
export function plannedFallbackFace(plan: FontPlan | null | undefined, family: string): string | null {
  const entry = plan?.families.find(candidate => candidate.family.toLowerCase() === family.toLowerCase());
  return entry?.fallback ? fallbackFaceName(entry.family) : null;
}

/** Applies the display and accent roles to blocks that choose them (render version 15). */
export const FONT_ROLE_CSS = '[data-font="display"]{font-family:var(--font-display)}[data-font="accent"]{font-family:var(--font-accent)}';
