// Custom CSS lint: finds custom CSS that works against the platform instead of
// through it. Read-only and deterministic; every finding names the Style,
// token or block setting that does the same job. Findings are warnings and
// never block a publication.

import type { Block, SiteSettings } from './types.js';

export type CssLintCode =
  | 'css_important_overuse'
  | 'css_font_not_in_theme'
  | 'css_first_section_background_image'
  | 'css_block_class_override'
  | 'css_duplicate_font_load';

export interface CssLintFinding {
  code: CssLintCode;
  /** `settings`, `page:<id>`, `partial:<id>`, `template:<id>` or `block_type:<id>`. */
  source: string;
  path: string;
  message: string;
  /** The platform feature that does the same job. */
  alternative: string;
  value?: string;
  count?: number;
  examples?: string[];
}

export interface CssLintSource {
  kind: 'page' | 'partial' | 'template' | 'block_type';
  id: string;
  css?: string;
  blocks?: Block[];
}

export interface CssRule { selector: string; body: string; at?: string }

/** `!important` count at or above which a stylesheet fights the theme rather than extending it. */
export const IMPORTANT_THRESHOLD = 10;

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'emoji', 'math', 'fangsong',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset', 'revert', 'revert-layer',
  '-apple-system', 'blinkmacsystemfont',
]);

const BLOCK_SELECTOR = /(?:\.block-[\w-]+|\[data-block\b[^\]]*\]|\.site-header\b|\.site-footer\b)/;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));
}

/** Flatten a stylesheet into style rules, descending into @media/@supports/@layer blocks. */
export function cssRules(input: string): CssRule[] {
  const css = stripComments(input);
  const rules: CssRule[] = [];
  const walk = (text: string, at?: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).replace(/^[\s;}]+/, '').trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const inner = text.slice(open + 1, j - 1);
      if (/^@(?:media|supports|layer|container|document)\b/i.test(prelude)) walk(inner, prelude);
      else if (prelude.startsWith('@')) rules.push({ selector: prelude, body: inner, ...(at ? { at } : {}) });
      else rules.push({ selector: prelude, body: inner, ...(at ? { at } : {}) });
      i = j;
    }
  };
  walk(css);
  return rules;
}

function declarations(body: string): Array<{ property: string; value: string }> {
  return body.split(';').flatMap(part => {
    const colon = part.indexOf(':');
    if (colon < 0) return [];
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    return property && value ? [{ property, value }] : [];
  });
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

/** The first named family of a `font-family` value or `font` shorthand, or null for generics and variables. */
export function primaryFontFamily(property: string, value: string): string | null {
  let families = value.replace(/!important/gi, '').trim();
  if (property === 'font') {
    // `font: [style] [weight] size[/line-height] family[, family]`
    const match = families.match(/(?:^|\s)(?:\d*\.?\d+(?:px|rem|em|%|pt|vw|vh|ex|ch)|(?:xx?-)?(?:small|large)|medium|smaller|larger)(?:\s*\/\s*[\w.%-]+)?\s+(.+)$/i);
    if (!match) return null;
    families = match[1];
  }
  const first = unquote(families.split(',')[0] ?? '');
  if (!first || /^var\(/i.test(first) || GENERIC_FAMILIES.has(first.toLowerCase())) return null;
  return first;
}

function themeFamilies(settings: Pick<SiteSettings, 'fonts'>): Set<string> {
  const fonts = settings.fonts ?? ({} as SiteSettings['fonts']);
  return new Set([fonts.heading, fonts.body, fonts.mono]
    .filter((font): font is string => typeof font === 'string' && Boolean(font.trim()))
    .flatMap(font => font.split(',').map(unquote).filter(Boolean))
    .map(font => font.toLowerCase()));
}

/** Families a stylesheet or HTML snippet loads itself: @font-face, @import and Google Fonts links. */
export function loadedFontFamilies(text: string): string[] {
  const out: string[] = [];
  const clean = stripComments(text);
  for (const match of clean.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const family = match[1].match(/font-family\s*:\s*([^;]+)/i);
    if (family) out.push(unquote(family[1]));
  }
  for (const match of clean.matchAll(/fonts\.googleapis\.com\/css2?\?([^"')\s>]+)/gi)) {
    const query = match[1].replace(/&amp;/g, '&');
    for (const part of query.split('&')) {
      if (!/^family=/i.test(part)) continue;
      for (const family of decodeURIComponent(part.slice(7).replace(/\+/g, ' ')).split('|')) {
        const name = family.split(':')[0].trim();
        if (name) out.push(name);
      }
    }
  }
  return [...new Set(out)];
}

function walkBlocks(blocks: Block[] | undefined, visit: (block: Block, path: string) => void, path = 'blocks') {
  (blocks ?? []).forEach((block, index) => {
    const at = `${path}[${index}]`;
    visit(block, at);
    walkBlocks(block.children, visit, `${at}.children`);
    block.slots?.forEach((slot, s) => walkBlocks(slot, visit, `${at}.slots[${s}]`));
  });
}

function hasBackgroundImage(body: string): string | null {
  for (const { property, value } of declarations(body)) {
    if ((property === 'background' || property === 'background-image') && /url\(/i.test(value)) return value.slice(0, 200);
  }
  return null;
}

/**
 * Lint every custom CSS surface: site custom CSS, Style CSS, scripts_head
 * (for font loads), page and block custom CSS, and custom block type styles.
 */
export function lintSiteCss(settings: Pick<SiteSettings, 'fonts' | 'custom_css' | 'scripts_head' | 'styles'>, sources: CssLintSource[]): CssLintFinding[] {
  const findings: CssLintFinding[] = [];
  const theme = themeFamilies(settings);
  const stylesheets: Array<{ source: string; path: string; css: string }> = [];
  if (settings.custom_css) stylesheets.push({ source: 'settings', path: 'custom_css', css: settings.custom_css });
  for (const style of settings.styles ?? []) if (style.css) stylesheets.push({ source: 'settings', path: `styles.${style.id}.css`, css: style.css });
  for (const source of sources) {
    const label = `${source.kind}:${source.id}`;
    if (source.css) stylesheets.push({ source: label, path: 'css', css: source.css });
    walkBlocks(source.blocks, (block, path) => {
      const css = block.style_overrides?.custom_css;
      if (typeof css === 'string' && css) stylesheets.push({ source: label, path: `${path}.style_overrides.custom_css`, css: `${block.style_overrides?.custom_class ? `.${block.style_overrides.custom_class}` : '&'}{${css}}` });
    });
  }

  const unknownFonts = new Map<string, { source: string; path: string; count: number }>();
  for (const sheet of stylesheets) {
    const important = (stripComments(sheet.css).match(/!\s*important/gi) ?? []).length;
    if (important >= IMPORTANT_THRESHOLD) {
      findings.push({ code: 'css_important_overuse', source: sheet.source, path: sheet.path, count: important,
        message: `${important} !important declarations override the theme instead of extending it.`,
        alternative: 'Set colours, fonts and sizes in site settings and named Styles, and use block settings for spacing and layout. Keep !important for documented exceptions.' });
    }
    const rules = cssRules(sheet.css);
    const blockSelectors = rules.filter(rule => !rule.selector.startsWith('@') && BLOCK_SELECTOR.test(rule.selector)).map(rule => rule.selector);
    if (blockSelectors.length) {
      findings.push({ code: 'css_block_class_override', source: sheet.source, path: sheet.path, count: blockSelectors.length,
        examples: [...new Set(blockSelectors)].slice(0, 5),
        message: `${blockSelectors.length} rule${blockSelectors.length === 1 ? '' : 's'} restyle platform block classes, which can change when blocks are updated.`,
        alternative: 'Use a named Style on the block, the block\'s own settings, or a custom_class on the block. Edit the header or footer partial for site-wide header and footer changes.' });
    }
    for (const rule of rules) {
      if (rule.selector.startsWith('@')) continue;
      for (const { property, value } of declarations(rule.body)) {
        if (property !== 'font-family' && property !== 'font') continue;
        const family = primaryFontFamily(property, value);
        if (!family || theme.has(family.toLowerCase())) continue;
        const key = `${sheet.source}\u0000${family.toLowerCase()}`;
        const entry = unknownFonts.get(key) ?? { source: sheet.source, path: sheet.path, count: 0 };
        entry.count++;
        unknownFonts.set(key, entry);
      }
    }
  }
  for (const [key, entry] of unknownFonts) {
    const family = key.split('\u0000')[1];
    findings.push({ code: 'css_font_not_in_theme', source: entry.source, path: entry.path, value: family, count: entry.count,
      message: `Custom CSS uses the font "${family}", which is not a theme font.`,
      alternative: 'Set the family as the heading, body or mono font in site settings and refer to it with the heading, body or mono font role.' });
  }

  // Fonts loaded a second time next to the theme's own font loading.
  const loads: Array<{ source: string; path: string; text: string }> = [
    ...stylesheets.map(sheet => ({ source: sheet.source, path: sheet.path, text: sheet.css })),
    ...(settings.scripts_head ? [{ source: 'settings', path: 'scripts_head', text: settings.scripts_head }] : []),
  ];
  for (const load of loads) {
    for (const family of loadedFontFamilies(load.text)) {
      if (!theme.has(family.toLowerCase())) continue;
      findings.push({ code: 'css_duplicate_font_load', source: load.source, path: load.path, value: family,
        message: `"${family}" is a theme font that the site already loads; ${load.path} loads it again.`,
        alternative: 'Remove the extra @font-face, @import or font link. The theme loads its heading, body and mono fonts once.' });
    }
  }

  // A background image on the first section is the largest paint the
  // leading-image rule cannot see, so it loads late.
  for (const source of sources) {
    if (source.kind !== 'page' || !source.blocks?.length) continue;
    const first = source.blocks[0];
    const label = `${source.kind}:${source.id}`;
    const own = first.style_overrides?.custom_css && hasBackgroundImage(first.style_overrides.custom_css);
    const dataClass = typeof first.data?.css_class === 'string' ? first.data.css_class : '';
    const cls = [first.style_overrides?.custom_class ?? '', dataClass].join(' ').split(/\s+/).filter(Boolean);
    let via: { path: string; value: string } | null = own ? { path: 'blocks[0].style_overrides.custom_css', value: own } : null;
    if (!via && cls.length) {
      for (const sheet of stylesheets.filter(sheet => sheet.source === 'settings' || sheet.source === label)) {
        for (const rule of cssRules(sheet.css)) {
          if (!cls.some(name => new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(rule.selector))) continue;
          const image = hasBackgroundImage(rule.body);
          if (image) { via = { path: `${sheet.source === 'settings' ? 'settings.' : ''}${sheet.path}`, value: image }; break; }
        }
        if (via) break;
      }
    }
    if (via) {
      findings.push({ code: 'css_first_section_background_image', source: label, path: via.path, value: via.value,
        message: 'The first section gets its background image from custom CSS, so the browser finds it late and cannot prioritise it.',
        alternative: 'Use an image or cover block, or the section block\'s background image setting, so the platform can load it eagerly with high priority.' });
    }
  }
  return findings;
}
