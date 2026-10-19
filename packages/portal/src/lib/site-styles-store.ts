// Reads and writes the site style library (SiteSettings.styles) for one site
// version. Every write validates each style, the library as a whole and text
// contrast against the site's colours (APCA, with WCAG 2 AA as the floor of
// acceptance; see styleContrastReport), so the UI, the v1 API and MCP enforce
// the same rules.

import {
  STANDARD_STYLES,
  STYLE_ELEMENT_ROLES,
  defaultSiteSettings,
  resolveRenderVersion,
  resolveStyleColor,
  siteStyleLibraryErrors,
  styleContrastReport,
  validateSiteStyle,
  type SiteColors,
  type SiteStyle,
  type StyleProps,
} from '@typeroll/shared';
import { vstore } from './version-store';

export interface StyleCtx { orgId: string; siteId: string; versionId: string }

export class StyleError extends Error {
  constructor(message: string, readonly status: number, readonly errors: string[] = [message]) { super(message); }
}

/** What the contrast checks measure against: the palette and the render version that picks automatic on_* colours. */
export interface StyleSite {
  colors: SiteColors;
  renderVersion: number;
}

export async function readStyles(ctx: StyleCtx): Promise<StyleSite & { styles: SiteStyle[] }> {
  const settings = (await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? defaultSiteSettings;
  const styles = (Array.isArray(settings.styles) ? settings.styles : []).flatMap(value => validateSiteStyle(value).style ?? []);
  return { styles, colors: siteColors(settings.colors), renderVersion: resolveRenderVersion(settings.render_version) };
}

function siteColors(colors: unknown): SiteColors {
  return { ...defaultSiteSettings.colors, ...((colors && typeof colors === 'object') ? colors as Record<string, string> : {}) };
}

/** Problems a library would have on this site; empty when it can be saved. */
export function libraryProblems(styles: SiteStyle[], colors: SiteColors, renderVersion = 1): string[] {
  return [...siteStyleLibraryErrors(styles), ...styles.flatMap(style => styleContrastReport(style, colors, { renderVersion }).errors)];
}

/** Readability notes that do not block saving: text below its APCA level that meets WCAG 2 AA. */
export function libraryWarnings(styles: SiteStyle[], colors: SiteColors, renderVersion = 1): string[] {
  return styles.flatMap(style => styleContrastReport(style, colors, { renderVersion }).warnings);
}

const warningsFor = (style: SiteStyle, site: StyleSite) => styleContrastReport(style, site.colors, { renderVersion: site.renderVersion }).warnings;

async function save(ctx: StyleCtx, styles: SiteStyle[], site: StyleSite): Promise<void> {
  const problems = libraryProblems(styles, site.colors, site.renderVersion);
  if (problems.length) throw new StyleError(problems[0], 400, problems);
  await vstore.writeSettings(ctx.orgId, ctx.siteId, ctx.versionId, { styles });
}

function parse(input: unknown): SiteStyle {
  const { style, errors } = validateSiteStyle(input);
  if (!style) throw new StyleError(errors[0] ?? 'Invalid style', 400, errors);
  return { ...style, updated_at: new Date().toISOString() };
}

/** Create a style. `warnings` are readability notes about it that do not block saving. */
export async function createStyle(ctx: StyleCtx, input: unknown): Promise<{ style: SiteStyle; warnings: string[] }> {
  const style = parse(input);
  const site = await readStyles(ctx);
  if (site.styles.some(existing => existing.id === style.id)) throw new StyleError(`A style with id "${style.id}" already exists`, 409);
  await save(ctx, [...site.styles, style], site);
  return { style, warnings: warningsFor(style, site) };
}

const mergeProps = (current: StyleProps | undefined, patch: unknown): StyleProps => {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries((patch ?? {}) as Record<string, unknown>)) {
    if (value === null) delete next[key]; else next[key] = value;
  }
  return next as StyleProps;
};

/**
 * Update a style. `base`, `hover` and each breakpoint under `at` merge
 * property by property (null removes one); other fields replace.
 */
export async function updateStyle(ctx: StyleCtx, id: string, patch: unknown): Promise<{ style: SiteStyle; warnings: string[] }> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StyleError('Body must be an object', 400);
  const p = patch as Record<string, unknown>;
  if (p.id !== undefined && p.id !== id) throw new StyleError('A style id cannot be changed; create a new style instead', 400);
  const site = await readStyles(ctx);
  const { styles } = site;
  const index = styles.findIndex(style => style.id === id);
  if (index < 0) throw new StyleError(`Style "${id}" not found`, 404);
  const current = styles[index];
  const at = { ...(current.at ?? {}) } as Record<string, StyleProps>;
  if (p.at !== undefined) {
    if (p.at === null) for (const key of Object.keys(at)) delete at[key];
    else for (const [bp, props] of Object.entries(p.at as Record<string, unknown>)) {
      if (props === null) delete at[bp]; else at[bp] = mergeProps(at[bp], props);
    }
  }
  const merged = {
    ...current,
    ...Object.fromEntries(Object.entries(p).filter(([key]) => !['base', 'at', 'hover', 'updated_at'].includes(key))),
    base: p.base === undefined ? current.base : mergeProps(current.base, p.base),
    ...(Object.keys(at).length ? { at } : { at: undefined }),
    ...(p.hover === undefined ? {} : { hover: p.hover === null ? undefined : mergeProps(current.hover, p.hover) }),
  };
  for (const key of ['description', 'css', 'role'] as const) if ((merged as Record<string, unknown>)[key] === null) delete (merged as Record<string, unknown>)[key];
  const style = parse(JSON.parse(JSON.stringify(merged)));
  const next = [...styles];
  next[index] = style;
  await save(ctx, next, site);
  return { style, warnings: warningsFor(style, site) };
}

export async function deleteStyle(ctx: StyleCtx, id: string): Promise<void> {
  const site = await readStyles(ctx);
  if (!site.styles.some(style => style.id === id)) throw new StyleError(`Style "${id}" not found`, 404);
  await save(ctx, site.styles.filter(style => style.id !== id), site);
}

/**
 * Add the standard styles a site is missing (matched by role). With
 * `overwrite`, standard roles are reset to the platform defaults; styles
 * without a standard role are never touched.
 *
 * `adjusted` lists added or reset styles that use the body text colour
 * because their palette colour is unreadable on this site; `warnings` says
 * for each what changed and why, with both contrast measures, and reports
 * added styles that are accepted below their APCA level.
 */
export async function applyStandardStyles(ctx: StyleCtx, opts: { overwrite?: boolean } = {}): Promise<{ added: string[]; replaced: string[]; adjusted: string[]; warnings: string[]; styles: SiteStyle[] }> {
  const site = await readStyles(ctx);
  const added: string[] = [];
  const replaced: string[] = [];
  const adjusted: string[] = [];
  const warnings: string[] = [];
  const next = [...site.styles];
  for (const original of STANDARD_STYLES) {
    const index = next.findIndex(style => style.role === original.role);
    if (index >= 0 && !opts.overwrite) continue;
    const { style: standard, notes } = readableOnPalette(original, site);
    if (notes.length) adjusted.push(original.id);
    warnings.push(...notes, ...warningsFor(standard, site));
    if (index >= 0) {
      next[index] = { ...standard, id: next[index].id, name: next[index].name, updated_at: new Date().toISOString() };
      replaced.push(next[index].id);
      continue;
    }
    // Keep a free id when the author already used the standard one.
    let id = standard.id;
    for (let n = 2; next.some(style => style.id === id); n++) id = `${standard.id}-${n}`;
    next.push({ ...standard, id, updated_at: new Date().toISOString() });
    added.push(id);
  }
  await save(ctx, next, site);
  return { added, replaced, adjusted, warnings, styles: next };
}

/**
 * A standard style whose palette text colour is unreadable on this site
 * (fails both APCA and WCAG 2 AA) is added with the body text colour
 * instead. Added unchanged it would be refused and block the whole standard
 * set. This shapes only styles being added or reset, never an existing
 * style, and every change is reported with its measures. Links keep their
 * underline, so they stay recognisable.
 */
function readableOnPalette(style: SiteStyle, site: StyleSite): { style: SiteStyle; notes: string[] } {
  const errors = styleContrastReport(style, site.colors, { renderVersion: site.renderVersion }).errors;
  if (!errors.length) return { style, notes: [] };
  const replaced = new Set<string>();
  const swap = (props: StyleProps | undefined) => {
    if (!props?.color || ['text', 'on_primary', 'on_secondary', 'on_accent'].includes(props.color)) return props;
    replaced.add(props.color);
    return { ...props, color: 'text' };
  };
  const at = style.at ? Object.fromEntries(Object.entries(style.at).map(([bp, props]) => [bp, swap(props)])) : undefined;
  const adapted = { ...style, base: swap(style.base)!, ...(at ? { at } : {}) };
  const text = resolveStyleColor('text', site.colors, site.renderVersion);
  const notes = errors.map(error => `${error} Added with the body text colour (text, ${text}) instead of ${[...replaced].join(', ')}; choose its colour again once the palette has a readable one.`);
  return { style: adapted, notes };
}

export function isElementRole(style: SiteStyle): boolean {
  return (STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role ?? '');
}
