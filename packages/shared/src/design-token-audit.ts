import { blockDataSchema } from './block-field-types.js';
import { defaultSiteSettings } from './defaults.js';
import { COLOR_TOKENS, TOKEN_SCALES, tokenScale, type TokenScale } from './design-tokens.js';
import { onColorValue } from './site-styles.js';
import type { Block, BlockType, FieldDefinition, SiteSettings } from './types.js';

export interface DesignTokenSource {
  kind: 'page' | 'partial' | 'template' | 'block_type';
  id: string;
  blocks?: Block[];
  css?: string;
  html?: string;
  schema?: FieldDefinition[];
}
export interface DesignTokenFinding {
  code: 'hardcoded_color' | 'hardcoded_size' | 'hardcoded_font';
  source: string;
  path: string;
  value: string | number;
  suggestions: string[];
  exact_matches: string[];
  message: string;
  block_id?: string;
  /** Only a direct scalar block colour can be migrated without rewriting CSS. */
  replacement?: { target: { kind: 'page' | 'partial' | 'template'; id: string }; block_id: string; field: string; before: string; after: string };
}
function rgb(value: string): number[] | null {
  const hex = value.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(hex)) return [...hex.slice(1)].map(c => parseInt(c + c, 16));
  if (/^#[0-9a-f]{6}$/.test(hex)) return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const match = hex.match(/^rgb\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*\)$/);
  return match && match.slice(1).every(n => +n <= 255) ? match.slice(1).map(Number) : null;
}
function lengthPx(value: string | number, base: number): number | null {
  if (typeof value === 'number') return value;
  const m = value.match(/^(\d+(?:\.\d+)?)(px|rem|em)?$/);
  return m ? +m[1] * (m[2] === 'rem' || m[2] === 'em' ? base : 1) : null;
}
/** Read-only, deterministic audit. Suggestions are never automatic editorial decisions. */
export function auditDesignTokens(input: SiteSettings, sources: DesignTokenSource[], registry: ReadonlyMap<string, BlockType>): DesignTokenFinding[] {
  const settings = { ...input, colors: { ...defaultSiteSettings.colors, ...input.colors }, fonts: { ...defaultSiteSettings.fonts, ...input.fonts } };
  const findings: DesignTokenFinding[] = [];
  const palette = Object.fromEntries(COLOR_TOKENS.map(token => [token,
    token.startsWith('on_') ? onColorValue(token as 'on_primary', settings.colors, settings.render_version)
      : settings.colors[token as keyof SiteSettings['colors']] ?? '']));
  const add = (code: DesignTokenFinding['code'], source: string, path: string, value: string | number, scale?: TokenScale): DesignTokenFinding => {
    let suggestions: string[] = [], exact_matches: string[] = [];
    if (code === 'hardcoded_color') {
      const actual = rgb(String(value));
      if (actual) {
        const distances = Object.entries(palette).flatMap(([key, color]) => { const parts = rgb(color); return parts ? [{ key, distance: parts.reduce((n, part, i) => n + (part - actual[i]) ** 2, 0) }] : []; }).sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
        exact_matches = distances.filter(d => d.distance === 0).map(d => d.key);
        suggestions = exact_matches.length ? exact_matches : distances.slice(0, 2).map(d => d.key);
      }
    } else if (code === 'hardcoded_size' && scale) {
      const steps = { ...TOKEN_SCALES[scale], ...settings.design_scales?.[scale] };
      const actual = lengthPx(value, 16);
      if (actual !== null) suggestions = Object.entries(steps).map(([key, v]) => ({ key, distance: Math.abs((lengthPx(v, 16) ?? Infinity) - actual) })).sort((a,b) => a.distance - b.distance).slice(0, 2).map(d => d.key);
    } else if (code === 'hardcoded_font') suggestions = ['heading', 'body', 'mono'];
    const finding: DesignTokenFinding = { code, source, path, value, suggestions, exact_matches,
      message: code === 'hardcoded_color' ? (exact_matches.length > 1 ? 'Multiple palette roles share this colour. Choose the semantic role before migrating.' : 'Use a palette role, or document this deliberate exception in decisions.md.') : 'Use a site scale or font role; document a deliberate override in decisions.md.' };
    findings.push(finding); return finding;
  };
  const css = (text: string | undefined, source: string, path: string) => {
    if (!text) return;
    // CSS declarations only: never rewrite or inspect prose, URLs, IDs, comments or JS.
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));
    const pattern = /(?:^|[;{\s"'])(color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?-color|fill|stroke|font-family|font-size|line-height|padding(?:-[\w]+)?|margin(?:-[\w]+)?|gap|row-gap|column-gap)\s*:\s*("[^"]*"|'[^']*'|[^;{}"'<>]+)/g;
    for (const m of clean.matchAll(pattern)) {
      const property = m[1], value = m[2].trim(), at = `${path}:line ${text.slice(0, m.index).split('\n').length}`;
      if (property === 'font-family' && !value.includes('var(--font-') && value !== 'inherit') add('hardcoded_font', source, at, value);
      else if (/^(?:font-size|line-height|padding|margin|gap|row-gap|column-gap)/.test(property)) {
        for (const size of value.matchAll(/(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em)\b/g)) add('hardcoded_size', source, at, size[0], property === 'font-size' ? 'type_size' : property === 'line-height' ? 'leading' : 'space');
      } else for (const color of value.matchAll(/#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) add('hardcoded_color', source, at, color[0]);
    }
  };
  const htmlCss = (text: string | undefined, source: string, path: string) => {
    if (!text) return;
    for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const fragment = match[1] ?? match[2] ?? match[3];
      css(fragment, source, `${path}:line ${text.slice(0, match.index).split('\n').length}`);
    }
  };
  const scanFields = (fields: FieldDefinition[], data: Record<string, unknown>, path: string, source: DesignTokenSource, block: Block, direct = true) => {
    for (const field of fields) {
      const value = data[field.name], at = `${path}.${field.name}`;
      if (value === undefined || value === null || value === '') continue;
      if (field.fields && (field.type === 'object' || field.type === 'array')) {
        const entries = Array.isArray(value) ? value.map((v,i) => [String(i), v] as const) : [['', value] as const];
        for (const [key, item] of entries) if (item && typeof item === 'object') scanFields(field.fields, item as Record<string,unknown>, key ? `${at}[${key}]` : at, source, block, false);
        continue;
      }
      const values = field.responsive && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [['', value]];
      for (const [bp, scalar] of values) {
        const loc = bp ? `${at}.${bp}` : at;
        if (field.type === 'color' && typeof scalar === 'string' && /^(?:#|rgba?\(|hsla?\()/.test(scalar)) {
          const finding = add('hardcoded_color', `${source.kind}:${source.id}`, loc, scalar); finding.block_id = block.id;
          if (direct && !bp && /^#/.test(scalar) && finding.exact_matches.length === 1 && block.id && source.kind !== 'block_type') finding.replacement = { target: { kind: source.kind, id: source.id }, block_id: block.id, field: field.name, before: scalar, after: finding.exact_matches[0] };
        } else if (tokenScale(field) && (typeof scalar === 'number' || typeof scalar === 'string' && /^\d/.test(scalar))) add('hardcoded_size', `${source.kind}:${source.id}`, loc, scalar, tokenScale(field));
        else if (/(?:^|_)(?:font|font_family)$/.test(field.name) && typeof scalar === 'string' && !['heading','body','mono','inherit'].includes(scalar)) add('hardcoded_font', `${source.kind}:${source.id}`, loc, scalar);
      }
      if (typeof value === 'string' && field.name === 'html') htmlCss(value, `${source.kind}:${source.id}`, at);
      else if (typeof value === 'string' && ['css','inline_style'].includes(field.name)) css(value, `${source.kind}:${source.id}`, at);
    }
  };
  for (const source of sources) {
    const visit = (blocks: Block[] | undefined, path: string) => (blocks ?? []).forEach((block,i) => {
      const at = `${path}[${i}]`;
      const type = registry.get(block.type);
      scanFields(type ? blockDataSchema(type, block.data ?? {}, registry) : [], block.data ?? {}, `${at}.data`, source, block);
      css(block.style_overrides?.custom_css, `${source.kind}:${source.id}`, `${at}.style_overrides.custom_css`);
      visit(block.children, `${at}.children`); block.slots?.forEach((slot,s) => visit(slot, `${at}.slots[${s}]`));
    });
    visit(source.blocks, 'blocks'); css(source.css, `${source.kind}:${source.id}`, 'css'); htmlCss(source.html, `${source.kind}:${source.id}`, 'html');
    if (source.schema) scanFields(source.schema, Object.fromEntries(source.schema.filter(f => f.default !== undefined).map(f => [f.name, f.default])), 'schema.defaults', source, { id: '', type: source.id, data: {} }, false);
  }
  css(settings.custom_css, 'settings', 'custom_css');
  for (const style of settings.styles ?? []) {
    for (const [state, props] of [['base', style.base], ['hover', style.hover], ...Object.entries(style.at ?? {})] as const) {
      if (!props) continue;
      const inspect = (obj: object, prefix: string) => {
        for (const [key,value] of Object.entries(obj)) {
          if (key === 'border' && value) { inspect(value, `${prefix}.border`); continue; }
          if (typeof value !== 'string') continue;
          const path = `${prefix}.${key}`;
          if (['color','background'].includes(key) && /^(?:#|rgba?\(|hsla?\()/.test(value)) add('hardcoded_color','settings',path,value);
          else if (key === 'font' && !['heading','body','mono','inherit'].includes(value)) add('hardcoded_font','settings',path,value);
          else if (['size','line_height','padding','space_before','space_after','gap'].includes(key) && /(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em)\b|^\d+(?:\.\d+)?$/.test(value)) add('hardcoded_size','settings',path,value,key === 'size' ? 'type_size' : key === 'line_height' ? 'leading' : 'space');
        }
      };
      inspect(props, `styles.${style.id}.${state}`);
    }
    css(style.css, 'settings', `styles.${style.id}.css`);
  }
  return findings;
}
