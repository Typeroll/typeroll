/**
 * Values derived from typed block fields, for templates and bindings:
 *
 * - `link` → an object with `href`, `target`, `rel` and `new_tab` beside the
 *   stored `page_id` / `url`. A page link resolves through the page source,
 *   so it follows slug changes; an external link keeps only safe schemes.
 * - `icon` → `{name}_svg`, the inline SVG.
 * - `array` and `object` with sub-fields → the same derivations on every
 *   item, at every depth.
 *
 * Derivation never mutates its input and never evaluates templates in values.
 */

import { safeLinkHref } from './article-blocks.js';
import { renderIconHtml } from './icons.js';
import type { FieldDefinition } from './types.js';

export interface LinkValue {
  page_id?: string;
  url?: string;
  new_tab?: boolean;
}

export interface ResolvedLink extends LinkValue {
  href: string;
  target: string;
  rel: string;
  new_tab: boolean;
}

/** Looks a page up by id; returns its public URL or undefined. */
export type PageUrlResolver = (pageId: string) => string | undefined;

/** Max nesting depth for derived values, matching the definition validator. */
const MAX_DEPTH = 4;

/**
 * A link field value as stored: an object, or a plain URL string (what a
 * `url` field held, so changing a field's type keeps working links).
 */
export function readLinkValue(value: unknown): LinkValue {
  if (typeof value === 'string') return value.trim() ? { url: value.trim() } : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: LinkValue = {};
  if (typeof raw.page_id === 'string' && raw.page_id.trim()) out.page_id = raw.page_id.trim();
  if (typeof raw.url === 'string' && raw.url.trim()) out.url = raw.url.trim();
  if (raw.new_tab === true) out.new_tab = true;
  return out;
}

/** Resolve a link to its href, falling back to the URL when the page is not published. */
export function resolveLink(value: unknown, pageUrl?: PageUrlResolver): ResolvedLink {
  const link = readLinkValue(value);
  const pageHref = link.page_id && pageUrl ? pageUrl(link.page_id) ?? '' : '';
  const href = pageHref || safeLinkHref(link.url ?? '');
  const newTab = link.new_tab === true && href !== '';
  return { ...link, href, target: newTab ? '_blank' : '', rel: newTab ? 'noopener' : '', new_tab: newTab };
}

/**
 * Field values plus everything derived from them. Unknown keys pass through
 * unchanged; derived keys never overwrite a stored value of the same name.
 */
export function deriveFieldValues(
  fields: readonly FieldDefinition[] | undefined,
  values: Record<string, unknown>,
  pageUrl?: PageUrlResolver,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  if (!fields?.length || depth >= MAX_DEPTH) return out;
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'link') {
      out[field.name] = resolveLink(value, pageUrl);
    } else if (field.type === 'icon') {
      const key = `${field.name}_svg`;
      if (!(key in values)) out[key] = renderIconHtml(String(value ?? ''));
    } else if (field.type === 'array' && field.fields?.length && Array.isArray(value)) {
      out[field.name] = value.map(item => item && typeof item === 'object' && !Array.isArray(item)
        ? deriveFieldValues(field.fields, item as Record<string, unknown>, pageUrl, depth + 1)
        : item);
    } else if (field.type === 'object' && field.fields?.length && value && typeof value === 'object' && !Array.isArray(value)) {
      out[field.name] = deriveFieldValues(field.fields, value as Record<string, unknown>, pageUrl, depth + 1);
    }
  }
  return out;
}

/** A page URL resolver over the renderer's page source, memoized per call site. */
export function pageUrlResolverFromSource(
  pageSource: ((config: { ids?: string[] }) => Record<string, unknown>[]) | undefined,
): PageUrlResolver | undefined {
  if (!pageSource) return undefined;
  const cache = new Map<string, string | undefined>();
  return (pageId) => {
    if (cache.has(pageId)) return cache.get(pageId);
    const url = pageSource({ ids: [pageId] })[0]?.url;
    const resolved = typeof url === 'string' && url ? url : undefined;
    cache.set(pageId, resolved);
    return resolved;
  };
}
