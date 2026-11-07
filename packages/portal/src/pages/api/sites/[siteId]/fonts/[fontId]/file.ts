// GET /api/sites/{siteId}/fonts/{fontId}/file   — the served WOFF2 file, for
//     same-origin portal pages that preview the font with @font-face.
//
// Private and short-lived in caches: the file is the site's licensed font,
// served only to people with access to the site. The ETag is its sha256.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { pathParam } from '../../../../../../lib/path-param';
import { readSiteFont, readSiteFontBytes } from '../../../../../../lib/fonts/font-library';

export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const id = pathParam(params.fontId);
  if (!id) return json({ error: 'Missing fontId' }, 400);
  const font = await readSiteFont(owner_org_id, site.id, id);
  if (!font) return json({ error: 'Font not found', code: 'font_not_found' }, 404);
  const etag = `"${font.file.sha256}"`;
  const headers = { 'Content-Type': 'font/woff2', 'Cache-Control': 'private, max-age=3600', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const bytes = await readSiteFontBytes(owner_org_id, site.id, font);
  return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Length': String(bytes.byteLength) } });
};
