// GET  /api/v1/sites/{siteId}/fonts   — the site's Fonts library and the roles
//      using each family: { fonts: SiteFontFile[], used_by: { [family]: role[] } }
// POST /api/v1/sites/{siteId}/fonts   — add a font file → 201 { font }
//   body: { filename, data_base64 } or { filename?, source_url } plus family?,
//   weight? (400 or "100-900"), style? ("normal" | "italic"), category?
//   ("sans" | "serif"), licence_confirmed: true, licence_note?
//
// WOFF2, WOFF, TTF and OTF files up to 10 MB; anything but WOFF2 is converted
// and its original kept. `licence_confirmed` records that the caller checked
// the licence allows use on this website. `source_url` is fetched here over
// HTTPS from a public address. Font files belong to the site, not a version.
// Writes are design work (an administrator or builder), like the settings
// that choose the families.

import type { APIRoute } from 'astro';
import { apiCanDesign, apiError, apiResponse, requireApiKey, type ApiContext } from '../../../../../../lib/api-auth';
import { apiUpdatedBy } from '../../../../../../lib/snippet-write';
import { addSiteFont, fontFailureBody, siteFontsResponse } from '../../../../../../lib/fonts/font-library';
import { checkUploadLength, decodeBase64Font } from '../../../../../../lib/fonts/font-requests';
import { fetchFontSource } from '../../../../../../lib/fonts/font-services';

const ACCEPTED = ['filename', 'data_base64', 'source_url', 'family', 'weight', 'style', 'category', 'licence_confirmed', 'licence_note'];

function fontFailure(error: unknown, ctx: ApiContext): Response {
  const refused = fontFailureBody(error);
  if (!refused) throw error;
  return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code, ...(refused.body.details ? { details: refused.body.details } : {}) });
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, await siteFontsResponse(ctx.orgId, ctx.siteId));
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!apiCanDesign(ctx)) return apiError('Insufficient permission (design required: an administrator or builder)', 403, ctx);
  try {
    checkUploadLength(request, 1.4);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);
    const unknown = Object.keys(body).filter(key => !ACCEPTED.includes(key));
    if (unknown.length) return apiError(`Unknown body keys: ${unknown.join(', ')}. Accepted keys: ${ACCEPTED.join(', ')}.`, 400, ctx, { code: 'font_details_invalid' });
    if ((body.data_base64 === undefined) === (body.source_url === undefined)) return apiError('Send exactly one of data_base64 (with filename) or source_url', 400, ctx, { code: 'font_details_invalid' });
    if (body.filename !== undefined && (typeof body.filename !== 'string' || body.filename.length > 255)) return apiError('filename must be a file name up to 255 characters', 400, ctx, { code: 'font_details_invalid' });
    let bytes: Uint8Array, filename = typeof body.filename === 'string' ? body.filename : undefined;
    if (body.data_base64 !== undefined) bytes = decodeBase64Font(body.data_base64);
    else {
      if (typeof body.source_url !== 'string') return apiError('source_url must be an https:// URL', 400, ctx, { code: 'font_details_invalid' });
      if (body.licence_confirmed !== true) return apiError('Confirm that the font\'s licence allows use on this website (licence_confirmed: true).', 400, ctx, { code: 'font_licence_required' });
      const fetched = await fetchFontSource(body.source_url);
      bytes = fetched.bytes; filename ??= fetched.filename;
    }
    const font = await addSiteFont(ctx.orgId, ctx.siteId, {
      bytes, filename,
      family: body.family, weight: body.weight, style: body.style, category: body.category,
      // JSON callers send a boolean; the string form is only for multipart.
      licence_confirmed: body.licence_confirmed === true, licence_note: body.licence_note,
      by: apiUpdatedBy(ctx.keyPrefix),
    });
    const { data_base64: _data, ...audited } = body;
    return apiResponse(ctx, { font }, 201, audited);
  } catch (error) { return fontFailure(error, ctx); }
};
