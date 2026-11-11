// Default markup of app contract components, written into built pages.
//
// Core asks each contract app once per publication for the default markup of
// every mount (component, variant, page language) and freezes the answer in
// the publication as `extension_markup`. The build writes it inside each
// mount after rendering, so the HTML sanitizer never filters it: only trusted
// developers can declare a contract, and they already run their own code on
// the page. Doing this on the built HTML rather than in the renderer also
// keeps reused (cached) page HTML correct when only the markup changed.

import { EXTENSION_DEFAULT_VARIANT } from './extensions.js';

export const EXTENSION_MARKUP_FORMAT = 1 as const;

/** A file an app returned with its default markup, at its content-addressed publication path. */
export interface FrozenExtensionAsset {
  path: string;
  content_type: string;
  body_base64: string;
}

export interface FrozenExtensionMarkupApp {
  extension_id: string;
  /** Markup by mount key, with `{{asset:name}}` already replaced by asset paths. */
  markup: Record<string, string>;
  assets: FrozenExtensionAsset[];
  /** Asset paths linked as stylesheets on every page with a mount of this app. */
  styles: string[];
}

export interface FrozenExtensionMarkup {
  format: typeof EXTENSION_MARKUP_FORMAT;
  /** Markup for a page language the app was not asked about falls back to this one. */
  default_language: string;
  /** By installation id. */
  apps: Record<string, FrozenExtensionMarkupApp>;
}

/** The key Core sends to the app for one mount; opaque to the app. */
export function extensionMarkupKey(componentId: string, variant: string, language: string): string {
  return `${componentId}|${variant}|${language}`;
}

/** Publication paths of app files; the immutable `/_assets/*` caching applies. */
export const EXTENSION_ASSET_PREFIX = '/_assets/apps/';

export function isExtensionAssetPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(EXTENSION_ASSET_PREFIX) &&
    /^\/_assets\/apps\/[a-z0-9-]{1,64}\/[a-f0-9]{16}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');
}

const MOUNT = /(<div\b(?=[^>]*\sdata-tr-extension-variant=")[^>]*>)(\s*<p class="tr-extension-placeholder">[^<]*<\/p>\s*)?<\/div>/g;

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Write each contract mount's default markup into a built page and link the
 * apps' stylesheets in its head. A mount without markup stays empty (its
 * editor placeholder is hidden on published pages).
 */
export function injectExtensionMarkup(html: string, frozen: FrozenExtensionMarkup | undefined | null): string {
  if (!frozen || frozen.format !== EXTENSION_MARKUP_FORMAT || !html.includes('data-tr-extension-variant=')) return html;
  const language = /<html\b[^>]*\slang="([^"]*)"/i.exec(html)?.[1] ?? frozen.default_language;
  const used = new Set<string>();
  const out = html.replace(MOUNT, (whole, open: string) => {
    const installationId = attribute(open, 'data-tr-extension-installation');
    const componentId = attribute(open, 'data-tr-extension-component');
    const app = installationId ? frozen.apps[installationId] : undefined;
    if (!app || !componentId) return whole;
    used.add(installationId!);
    const variant = attribute(open, 'data-tr-extension-variant') || EXTENSION_DEFAULT_VARIANT;
    const markup = app.markup[extensionMarkupKey(componentId, variant, language)] ??
      app.markup[extensionMarkupKey(componentId, variant, frozen.default_language)];
    return markup === undefined ? whole : `${open}${markup}</div>`;
  });
  const styles = [...new Set([...used].flatMap((id) => frozen.apps[id]!.styles ?? []).filter(isExtensionAssetPath))];
  if (!styles.length) return out;
  // Before the page's first stylesheet, so platform and site CSS can override the app's base look.
  const links = styles.map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}" data-tr-extension-style>`).join('');
  const head = /<head\b[^>]*>/i.exec(out);
  if (!head) return out;
  const start = head.index + head[0].length;
  const end = out.indexOf('</head>', start);
  const section = out.slice(start, end === -1 ? undefined : end);
  const first = /<link\b[^>]*\brel="?stylesheet"?[^>]*>|<style\b/i.exec(section);
  const at = first ? start + first.index : end === -1 ? start : end;
  return `${out.slice(0, at)}${links}${out.slice(at)}`;
}
