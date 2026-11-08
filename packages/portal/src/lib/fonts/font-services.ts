// Reading a font service's stylesheet (an Adobe Fonts kit, a Bunny Fonts or
// Fontshare stylesheet) to learn the family names it defines, so the roles
// can choose them. The stylesheet is fetched once, when the service is
// added; a publication loads it from the service's CDN.
//
// Remote fonts from URLs (`source_url` uploads) are fetched here too, with the
// same guarded fetch: HTTPS only, public addresses, a byte cap and a deadline.

import { ADOBE_KIT_PATTERN, fontServiceProvider, fontServiceStylesheet, MAX_FONT_UPLOAD_BYTES, serviceStylesheetFamilies, type FontService } from '@typeroll/shared';
import { createSafeFetch, OutboundRequestError } from '../net/safe-fetch';
import { FontLibraryError } from './font-library';

const STYLESHEET_MAX_BYTES = 512 * 1024;

const sourceError = (message: string) => new FontLibraryError(message, 502, 'font_source_unavailable');

/** The service a request names, validated, without its families yet. */
export function fontServiceInput(body: Record<string, unknown> | null): { provider: 'adobe'; kit: string } | { provider: 'bunny' | 'fontshare'; url: string } {
  if (!body || typeof body !== 'object') throw new FontLibraryError('Send { provider: "adobe", kit } or { provider: "bunny" | "fontshare", url }', 400, 'font_details_invalid');
  if (body.provider === 'adobe') {
    const kit = typeof body.kit === 'string' ? body.kit.trim() : '';
    if (!ADOBE_KIT_PATTERN.test(kit)) throw new FontLibraryError('kit must be an Adobe Fonts web project ID (5–12 lowercase letters and digits, from the embed code https://use.typekit.net/<id>.css)', 400, 'font_details_invalid');
    return { provider: 'adobe', kit };
  }
  if (body.provider === 'bunny' || body.provider === 'fontshare') {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (fontServiceProvider(url) !== body.provider) {
      throw new FontLibraryError(`url must be a ${body.provider === 'bunny' ? 'https://fonts.bunny.net/css?family=…' : 'https://api.fontshare.com/v2/css?f[]=…'} stylesheet URL`, 400, 'font_details_invalid');
    }
    return { provider: body.provider, url };
  }
  throw new FontLibraryError('provider must be adobe, bunny or fontshare', 400, 'font_details_invalid');
}

/** Fetch a service stylesheet and list the families it defines. */
export async function inspectFontService(service: ReturnType<typeof fontServiceInput>, fetchImpl?: typeof fetch): Promise<{ families: string[]; stylesheet: string }> {
  const stylesheet = fontServiceStylesheet({ ...service, families: [] } as FontService);
  const guarded = fetchImpl ?? createSafeFetch({ label: 'Font service stylesheet', maxRedirects: 0, timeoutMs: 10_000, maxBytes: STYLESHEET_MAX_BYTES });
  let css: string;
  try {
    // maxRedirects 0: a redirect is refused rather than followed to another host.
    const response = await guarded(stylesheet, { headers: { accept: 'text/css,*/*;q=0.1' } });
    if (!response.ok) {
      throw sourceError(response.status === 404 && service.provider === 'adobe'
        ? 'Adobe Fonts does not know this web project. Check the ID in the embed code, and that the project is published.'
        : `The stylesheet answered ${response.status}`);
    }
    css = await response.text();
  } catch (error) {
    if (error instanceof FontLibraryError) throw error;
    throw sourceError(`The stylesheet could not be read (${error instanceof OutboundRequestError || error instanceof Error ? error.message : 'unreachable'})`);
  }
  const families = serviceStylesheetFamilies(css);
  if (!families.length) throw new FontLibraryError('The stylesheet defines no fonts. For Adobe Fonts, add fonts to the web project and publish it.', 422, 'font_service_empty');
  return { families, stylesheet };
}

/** Download a font file for an upload by URL. */
export async function fetchFontSource(sourceUrl: string, fetchImpl?: typeof fetch): Promise<{ bytes: Uint8Array; filename: string }> {
  let url: URL;
  try { url = new URL(sourceUrl); } catch { throw new FontLibraryError('source_url must be an https:// URL', 400, 'font_details_invalid'); }
  if (url.protocol !== 'https:') throw new FontLibraryError('source_url must be an https:// URL', 400, 'font_details_invalid');
  const guarded = fetchImpl ?? createSafeFetch({ label: 'Font URL', maxRedirects: 3, timeoutMs: 20_000, maxBytes: MAX_FONT_UPLOAD_BYTES });
  try {
    const response = await guarded(url, { headers: { accept: 'font/woff2,font/*,application/octet-stream;q=0.5,*/*;q=0.1' } });
    if (!response.ok) throw sourceError(`The font URL answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const last = url.pathname.split('/').pop() || 'font';
    let filename = last;
    try { filename = decodeURIComponent(last); } catch { /* keep it encoded */ }
    return { bytes, filename };
  } catch (error) {
    if (error instanceof FontLibraryError) throw error;
    if (error instanceof OutboundRequestError && error.code === 'response_too_large') throw new FontLibraryError(`The font file is larger than ${MAX_FONT_UPLOAD_BYTES / 1024 / 1024} MB`, 413, 'font_too_large');
    throw sourceError(`The font URL could not be read (${error instanceof Error ? error.message : 'unreachable'})`);
  }
}
