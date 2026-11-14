import type { APIRoute } from 'astro';
import { verifyActivePreviewToken } from '../../../../lib/preview-signing';
import { privateMediaReadUrl } from '../../../../lib/publishing/media-storage';
import { connectionFailure } from '../../../../lib/publishing/http';

// A review preview moves between pages that show the same images. The browser
// keeps each file (and this redirect to it) for up to an hour while the link is
// valid, so the next page does not download every image again. `variant` names
// a prepared size and format (`w640.avif`), the same files a publication uses.
export const GET: APIRoute = async ({ request, params }) => {
  const query = new URL(request.url).searchParams;
  const ticket = await verifyActivePreviewToken(query.get('token'));
  if (!ticket || ticket.site_id !== params.siteId) return new Response('Preview expired or unavailable.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  try {
    const remaining = Math.floor(ticket.exp - Date.now() / 1000);
    const cacheSeconds = Math.max(0, Math.min(3600, remaining - 120));
    const url = await privateMediaReadUrl(ticket.org_id, ticket.site_id, params.mediaId!, remaining, { variant: query.get('variant') ?? undefined, cacheSeconds });
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': cacheSeconds ? `private, max-age=${cacheSeconds}` : 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (error) { return connectionFailure(error); }
};
