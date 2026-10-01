// Reads and writes the site style library (SiteSettings.styles) for one site
// version. Every write validates each style, the library as a whole and text
// contrast against the site's colours, so the UI, the v1 API and MCP enforce
// the same rules.

import {
  STANDARD_STYLES,
  STYLE_ELEMENT_ROLES,
  defaultSiteSettings,
  siteStyleLibraryErrors,
  styleContrastErrors,
  validateSiteStyle,
  type SiteStyle,
  type StyleProps,
} from '@typeroll/shared';
import { vstore } from './version-store';

export interface StyleCtx { orgId: string; siteId: string; versionId: string }

export class StyleError extends Error {
  constructor(message: string, readonly status: number, readonly errors: string[] = [message]) { super(message); }
}

export async function readStyles(ctx: StyleCtx): Promise<{ styles: SiteStyle[]; colors: NonNullable<ReturnType<typeof siteColors>> }> {
  const settings = (await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? defaultSiteSettings;
  const styles = (Array.isArray(settings.styles) ? settings.styles : []).flatMap(value => validateSiteStyle(value).style ?? []);
  return { styles, colors: siteColors(settings.colors) };
}

function siteColors(colors: unknown) {
  return { ...defaultSiteSettings.colors, ...((colors && typeof colors === 'object') ? colors as Record<string, string> : {}) };
}

/** Problems a library would have on this site; empty when it can be saved. */
export function libraryProblems(styles: SiteStyle[], colors: Record<string, string>): string[] {
  return [...siteStyleLibraryErrors(styles), ...styles.flatMap(style => styleContrastErrors(style, colors))];
}

async function save(ctx: StyleCtx, styles: SiteStyle[], colors: Record<string, string>): Promise<SiteStyle[]> {
  const problems = libraryProblems(styles, colors);
  if (problems.length) throw new StyleError(problems[0], 400, problems);
  await vstore.writeSettings(ctx.orgId, ctx.siteId, ctx.versionId, { styles });
  return styles;
}

function parse(input: unknown): SiteStyle {
  const { style, errors } = validateSiteStyle(input);
  if (!style) throw new StyleError(errors[0] ?? 'Invalid style', 400, errors);
  return { ...style, updated_at: new Date().toISOString() };
}

export async function createStyle(ctx: StyleCtx, input: unknown): Promise<SiteStyle> {
  const style = parse(input);
  const { styles, colors } = await readStyles(ctx);
  if (styles.some(existing => existing.id === style.id)) throw new StyleError(`A style with id "${style.id}" already exists`, 409);
  await save(ctx, [...styles, style], colors);
  return style;
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
export async function updateStyle(ctx: StyleCtx, id: string, patch: unknown): Promise<SiteStyle> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StyleError('Body must be an object', 400);
  const p = patch as Record<string, unknown>;
  if (p.id !== undefined && p.id !== id) throw new StyleError('A style id cannot be changed; create a new style instead', 400);
  const { styles, colors } = await readStyles(ctx);
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
  await save(ctx, next, colors);
  return style;
}

export async function deleteStyle(ctx: StyleCtx, id: string): Promise<void> {
  const { styles, colors } = await readStyles(ctx);
  if (!styles.some(style => style.id === id)) throw new StyleError(`Style "${id}" not found`, 404);
  await save(ctx, styles.filter(style => style.id !== id), colors);
}

/**
 * Add the standard styles a site is missing (matched by role). With
 * `overwrite`, standard roles are reset to the platform defaults; styles
 * without a standard role are never touched.
 */
export async function applyStandardStyles(ctx: StyleCtx, opts: { overwrite?: boolean } = {}): Promise<{ added: string[]; replaced: string[]; adjusted: string[]; styles: SiteStyle[] }> {
  const { styles, colors } = await readStyles(ctx);
  const added: string[] = [];
  const replaced: string[] = [];
  const adjusted: string[] = [];
  const next = [...styles];
  for (const original of STANDARD_STYLES) {
    const standard = readableOnPalette(original, colors);
    if (standard !== original) adjusted.push(original.id);
    const index = next.findIndex(style => style.role === standard.role);
    if (index >= 0) {
      if (!opts.overwrite) continue;
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
  await save(ctx, next, colors);
  return { added, replaced, adjusted, styles: next };
}

/**
 * A standard style whose palette colour is unreadable on this site's
 * background falls back to the body text colour, so the standard set can
 * always be added. Links keep their underline, so they stay recognisable.
 */
function readableOnPalette(style: SiteStyle, colors: Record<string, string>): SiteStyle {
  if (!styleContrastErrors(style, colors).length) return style;
  const swap = (props: StyleProps | undefined) => props && props.color && !['text', 'on_primary', 'on_secondary', 'on_accent'].includes(props.color) ? { ...props, color: 'text' } : props;
  const at = style.at ? Object.fromEntries(Object.entries(style.at).map(([bp, props]) => [bp, swap(props)])) : undefined;
  return { ...style, base: swap(style.base)!, ...(at ? { at } : {}) };
}

export function isElementRole(style: SiteStyle): boolean {
  return (STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role ?? '');
}
