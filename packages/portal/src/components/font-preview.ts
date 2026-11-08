// Loading fonts for previews in the portal: the site's Fonts library (one
// request per page), stylesheets linked once into the portal document, and
// uploaded files as data URLs for sandboxed preview frames.

import { useEffect, useMemo, useState } from 'react';
import type { SiteFontFile, SiteFontRole } from '@typeroll/shared';
import { fontFileUrl, previewFontHead, sitePreviewFonts, uploadFontFaceCss, type SiteFonts } from './font-picker-model';

export interface SiteFontLibrary { fonts: SiteFontFile[]; used_by: Record<string, SiteFontRole[]> }

const libraries = new Map<string, Promise<SiteFontLibrary>>();

/** The site's Fonts library, fetched once per page. A failed request yields an empty library. */
export function loadSiteFontLibrary(siteId: string, options: { refresh?: boolean } = {}): Promise<SiteFontLibrary> {
  if (!options.refresh && libraries.has(siteId)) return libraries.get(siteId)!;
  const request = fetch(`/api/sites/${encodeURIComponent(siteId)}/fonts`, { headers: { accept: 'application/json' } })
    .then(async response => {
      if (!response.ok) throw new Error(`Loading fonts failed (${response.status})`);
      const body = await response.json() as Partial<SiteFontLibrary>;
      return { fonts: Array.isArray(body.fonts) ? body.fonts : [], used_by: body.used_by ?? {} };
    });
  const settled = request.catch(() => ({ fonts: [], used_by: {} }));
  libraries.set(siteId, settled);
  return settled;
}

/** Replace the cached library after an upload, edit or delete on this page. */
export function setSiteFontLibrary(siteId: string, library: SiteFontLibrary) {
  libraries.set(siteId, Promise.resolve(library));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('typeroll:site-fonts', { detail: { siteId } }));
}

/** The site's uploaded fonts, or null while loading or without a site. */
export function useSiteFontFiles(siteId: string | undefined, initial?: SiteFontFile[] | null): SiteFontFile[] | null {
  const [files, setFiles] = useState<SiteFontFile[] | null>(initial ?? null);
  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    const load = () => loadSiteFontLibrary(siteId).then(library => { if (!cancelled) setFiles(library.fonts); });
    if (!initial) load();
    const onChange = (event: Event) => { if ((event as CustomEvent).detail?.siteId === siteId) load(); };
    window.addEventListener('typeroll:site-fonts', onChange);
    return () => { cancelled = true; window.removeEventListener('typeroll:site-fonts', onChange); };
  }, [siteId, initial]);
  return files;
}

const linked = new Set<string>();

/** Link a preview stylesheet into the portal document once. */
export function ensureStylesheet(href: string | null | undefined) {
  if (!href || typeof document === 'undefined' || linked.has(href)) return;
  linked.add(href);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.fontPreview = '';
  document.head.append(link);
}

/**
 * `@font-face` rules for the site's uploaded files in the portal document.
 * Browsers download a face only when text uses it, so declaring the whole
 * library costs nothing until a preview shows it.
 */
export function ensureUploadFaces(siteId: string, files: readonly SiteFontFile[]) {
  if (typeof document === 'undefined') return;
  const id = `font-preview-uploads-${siteId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.append(style);
  }
  const css = uploadFontFaceCss(files, file => fontFileUrl(siteId, file.id));
  if (style.textContent !== css) style.textContent = css;
}

const dataUrls = new Map<string, Promise<string | null>>();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** An uploaded file as a data URL, for a sandboxed frame that cannot send the sign-in cookie. */
export function fontFileDataUrl(siteId: string, file: Pick<SiteFontFile, 'id' | 'file'>): Promise<string | null> {
  const key = `${siteId}/${file.id}/${file.file?.sha256 ?? ''}`;
  if (!dataUrls.has(key)) {
    dataUrls.set(key, fetch(fontFileUrl(siteId, file.id))
      .then(async response => response.ok ? `data:font/woff2;base64,${base64(new Uint8Array(await response.arrayBuffer()))}` : null)
      .catch(() => null));
  }
  return dataUrls.get(key)!;
}

/** Data URLs for these files, keyed by file id; files that fail to load are left out. */
export async function fontFileDataUrls(siteId: string, files: readonly SiteFontFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(files.map(async file => [file.id, await fontFileDataUrl(siteId, file)] as const));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => !!entry[1]));
}

/**
 * `<link>` and `<style>` markup that loads the site's role families inside a
 * sandboxed preview frame: Google and service stylesheets by URL, uploaded
 * files as data URLs once they are fetched.
 */
export function useSandboxFontHead(siteId: string | undefined, fonts: SiteFonts | null | undefined, files: readonly SiteFontFile[] | null): string {
  // Keyed by content, so callers may pass new objects on every render.
  const key = JSON.stringify([siteId, fonts ?? null, files?.map(file => [file.id, file.family, file.weight, file.style, file.file?.sha256]) ?? null]);
  // With a site, wait for its library so an uploaded family is not asked of Google.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => fonts && (!siteId || files) ? sitePreviewFonts(fonts, files) : { stylesheets: [], uploads: [] }, [key]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!siteId || !plan.uploads.length) return;
    let cancelled = false;
    fontFileDataUrls(siteId, plan.uploads as SiteFontFile[]).then(next => {
      if (!cancelled) setUrls(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    });
    return () => { cancelled = true; };
  }, [siteId, plan]);
  return useMemo(() => previewFontHead(plan, file => urls[file.id] ?? null), [plan, urls]);
}
