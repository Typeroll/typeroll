import crypto from 'node:crypto';
import {
  collectFontUsage, fontDelivery, googleFontFileUrls, resolveRenderVersion, rewriteGoogleFontCss,
  type Block, type BlockType, type FontPlan, type SiteFontFile, type SiteSettings,
} from '@typeroll/shared';
import { BROWSER_USER_AGENT, fetchGoogleFontsCss, MAX_FONT_BYTES } from '../extensions/theme-fonts';
import { fetchPublicAsset } from '../extensions/public-http';
import { createSafeFetch } from '../net/safe-fetch';
import { libraryFontFaceCss, plannedLibraryFiles, siteFontPlan } from './font-delivery';
import { listSiteFonts, readSiteFontBytes } from './font-library';

// The editor preview loads the same font files as the published site.
//
// Previews are sandboxed documents with an opaque origin: they send no
// cookies, and the browser loads their fonts with CORS. Self-hosted files
// (the site's uploaded fonts, and Google's when the site self-hosts) are
// therefore served by a signed, short-lived route that needs no session:
//
//   /api/preview-fonts/<token>/fonts.css     the stylesheet
//   /api/preview-fonts/<token>/<hash>.woff2  an uploaded file
//   /api/preview-fonts/<token>/g/<path>      a Google file, fetched by the portal
//
// The token signs the organization, site, the Google stylesheet URL and the
// uploaded file ids the stylesheet may name, so it reveals nothing else. The
// visitor's browser never contacts Google for a self-hosting site; Google's
// stylesheet and files are fetched by the portal and kept in a bounded
// in-memory cache keyed by their URL.
//
// The preview plans the fonts of the page it shows (its body, template,
// header, footer and the global blocks they place) with the same planner as
// a publication, so it loads what that page loads once published. Google
// CDN delivery and font service stylesheets load from their CDN, as on the
// site. Fallback faces need the copied files and are left to the publication.

const TOKEN_TTL_SECONDS = 60 * 60;
const PURPOSE = 'typeroll-preview-fonts\n';
const GOOGLE_CSS = /^https:\/\/fonts\.googleapis\.com\/css2\?[^\s#]*$/;
const GOOGLE_FILE_PATH = /^s\/[A-Za-z0-9._~/-]+\.(woff2|woff|ttf|otf)$/;
const LIBRARY_FILE = /^([a-f0-9]{32})\.woff2$/;

interface FontTicket { o: string; s: string; e: number; g?: string; f?: string[] }

function secret(): string | null {
  const value = process.env.PREVIEW_HMAC_SECRET;
  return value && value.length >= 32 ? value : null;
}
const mac = (key: string, payload: string) => crypto.createHmac('sha256', key).update(PURPOSE + payload).digest('base64url');

/**
 * A token for the preview font route. It expires at the end of the next
 * hour, so the canvas, which renders on every edit, reuses one stylesheet URL
 * (and the browser's copy of it) for at least an hour.
 */
export function signPreviewFontToken(ticket: { orgId: string; siteId: string; googleCssUrl?: string | null; fileIds?: string[] }, now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const hour = TOKEN_TTL_SECONDS * 1000;
  const payload: FontTicket = { o: ticket.orgId, s: ticket.siteId, e: Math.ceil(now / hour) * TOKEN_TTL_SECONDS + TOKEN_TTL_SECONDS,
    ...(ticket.googleCssUrl ? { g: ticket.googleCssUrl } : {}), ...(ticket.fileIds?.length ? { f: [...ticket.fileIds].sort() } : {}) };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${mac(key, encoded)}`;
}

export function verifyPreviewFontToken(token: string | undefined | null, now = Date.now()): FontTicket | null {
  const key = secret();
  if (!key || typeof token !== 'string' || token.length > 8192) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = mac(key, encoded);
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  let ticket: FontTicket;
  try { ticket = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof ticket?.o !== 'string' || typeof ticket.s !== 'string' || typeof ticket.e !== 'number' || ticket.e * 1000 < now) return null;
  if (ticket.g !== undefined && (typeof ticket.g !== 'string' || !GOOGLE_CSS.test(ticket.g))) return null;
  if (ticket.f !== undefined && (!Array.isArray(ticket.f) || !ticket.f.every(id => typeof id === 'string'))) return null;
  return ticket;
}

// ── What a preview links ──────────────────────────────────────────────────

export interface PreviewFonts {
  plan: FontPlan;
  /** Stylesheets to link, in order: the signed self-hosted one, then Google's CDN. */
  stylesheets: string[];
  /** Whether a stylesheet is Google's CDN (for its preconnect). */
  googleCdn: boolean;
  /** Font service stylesheets, from their CDN. */
  services: string[];
}

/** The fonts a preview of these blocks loads. A Fonts library that cannot be read leaves the uploaded fonts out of the preview. */
export async function previewFonts(orgId: string, siteId: string, settings: SiteSettings, blocks: Iterable<Block>, blockTypes: ReadonlyMap<string, Pick<BlockType, 'schema'>>): Promise<PreviewFonts> {
  let library: SiteFontFile[] = [];
  try { library = await listSiteFonts(orgId, siteId); }
  catch (error) { console.warn(JSON.stringify({ event: 'preview_fonts_library_unavailable', site_id: siteId, error: error instanceof Error ? error.message : String(error) })); }
  const renderVersion = resolveRenderVersion(settings.render_version);
  const plan = siteFontPlan(settings.fonts, collectFontUsage({ styles: settings.styles, blocks, blockTypes }), { renderVersion, library });
  const delivery = fontDelivery(settings.fonts);
  const fileIds = plannedLibraryFiles(plan, library).map(entry => entry.file.id);
  const selfHostedGoogle = delivery === 'self_hosted' ? plan.google_css_url : null;
  const token = selfHostedGoogle || fileIds.length ? signPreviewFontToken({ orgId, siteId, googleCssUrl: selfHostedGoogle, fileIds }) : null;
  const base = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  const stylesheets: string[] = [];
  if (token) stylesheets.push(`${base}/api/preview-fonts/${token}/fonts.css`);
  // Without a signing secret (a bare local portal) Google's files load from its CDN, as before.
  const googleCdn = delivery === 'google' || (!token && !!selfHostedGoogle) ? plan.google_css_url : null;
  if (googleCdn) stylesheets.push(googleCdn);
  return { plan, stylesheets, googleCdn: !!googleCdn, services: plan.service_stylesheets };
}

// ── The route ─────────────────────────────────────────────────────────────

/** A small LRU of Google responses by URL, bounded by entries and bytes. */
class ByteCache<T extends string | Uint8Array> {
  private entries = new Map<string, { value: T; at: number }>();
  private bytes = 0;
  constructor(private maxEntries: number, private maxBytes: number, private ttlMs: number) {}
  private size = (value: T) => typeof value === 'string' ? value.length : value.byteLength;
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (Date.now() - entry.at > this.ttlMs) { this.bytes -= this.size(entry.value); return undefined; }
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T) {
    const old = this.entries.get(key);
    if (old) { this.bytes -= this.size(old.value); this.entries.delete(key); }
    this.entries.set(key, { value, at: Date.now() });
    this.bytes += this.size(value);
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= this.size(entry.value);
    }
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
const googleCss = new ByteCache<string>(128, 4 * 1024 * 1024, 24 * 60 * 60 * 1000);
const googleFiles = new ByteCache<Uint8Array>(512, 48 * 1024 * 1024, 7 * 24 * 60 * 60 * 1000);
/** Test hook. */
export const clearPreviewFontCache = () => { googleCss.clear(); googleFiles.clear(); };

const defaultFetch = () => createSafeFetch({ label: 'Asset URL', maxRedirects: 0, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
const headers = (contentType: string, maxAge: number) => ({
  'Content-Type': contentType,
  // Sandboxed previews have an opaque origin; fonts load with CORS.
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': `private, max-age=${maxAge}`,
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
});
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
const FONT_TYPES: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

/** Serve one path below /api/preview-fonts/<token>/. */
export async function servePreviewFont(token: string, file: string, fetchImpl: typeof fetch = defaultFetch()): Promise<Response> {
  const ticket = verifyPreviewFontToken(token);
  if (!ticket) return notFound();
  const allowed = new Set(ticket.f ?? []);
  const library = async () => allowed.size ? (await listSiteFonts(ticket.o, ticket.s)).filter(font => allowed.has(font.id)) : [];
  try {
    if (file === 'fonts.css') {
      const parts: string[] = [];
      if (ticket.g) {
        let css = googleCss.get(ticket.g);
        if (css === undefined) { css = await fetchGoogleFontsCss(ticket.g, fetchImpl); googleCss.set(ticket.g, css); }
        const local = new Map(googleFontFileUrls(css).map(url => [url, `g/${new URL(url).pathname.slice(1)}`]));
        parts.push(rewriteGoogleFontCss(css, local));
      }
      // Family names match case-insensitively, as the planner matched the role's family to the files.
      for (const font of await library()) parts.push(libraryFontFaceCss(font.family, font, `${font.file.sha256.slice(0, 32)}.woff2`));
      return new Response(parts.filter(Boolean).join('\n') + '\n', { status: 200, headers: headers('text/css; charset=utf-8', TOKEN_TTL_SECONDS) });
    }
    const uploaded = LIBRARY_FILE.exec(file);
    if (uploaded) {
      const font = (await library()).find(candidate => candidate.file.sha256.startsWith(uploaded[1]));
      if (!font) return notFound();
      return new Response(new Uint8Array(await readSiteFontBytes(ticket.o, ticket.s, font, 'file')), { status: 200, headers: headers('font/woff2', 24 * 60 * 60) });
    }
    if (ticket.g && file.startsWith('g/')) {
      const path = file.slice(2);
      const match = GOOGLE_FILE_PATH.exec(path);
      if (!match) return notFound();
      const url = `https://fonts.gstatic.com/${path}`;
      // Only files the signed stylesheet names.
      let css = googleCss.get(ticket.g);
      if (css === undefined) { css = await fetchGoogleFontsCss(ticket.g, fetchImpl); googleCss.set(ticket.g, css); }
      if (!googleFontFileUrls(css).includes(url)) return notFound();
      let bytes = googleFiles.get(url);
      if (!bytes) { bytes = await fetchPublicAsset(url, MAX_FONT_BYTES, fetchImpl, { 'User-Agent': BROWSER_USER_AGENT }); googleFiles.set(url, bytes); }
      return new Response(new Uint8Array(bytes), { status: 200, headers: headers(FONT_TYPES[match[1]], 24 * 60 * 60) });
    }
    return notFound();
  } catch (error) {
    console.warn(JSON.stringify({ event: 'preview_fonts_unavailable', site_id: ticket.s, error: error instanceof Error ? error.message : String(error) }));
    return new Response('Fonts unavailable', { status: 502, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
  }
}
