import type { APIRoute } from 'astro';
import { verifyActivePreviewToken } from '../../../../lib/preview-signing';
import { privateMediaReadUrl } from '../../../../lib/publishing/media-storage';
import { connectionFailure } from '../../../../lib/publishing/http';

export const GET: APIRoute = async ({ request, params }) => {
  const ticket = await verifyActivePreviewToken(new URL(request.url).searchParams.get('token'));
  if (!ticket || ticket.site_id !== params.siteId) return new Response('Preview expired or unavailable.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  try {
    const url = await privateMediaReadUrl(ticket.org_id, ticket.site_id, params.mediaId!, Math.floor(ticket.exp - Date.now() / 1000));
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (error) { return connectionFailure(error); }
};
