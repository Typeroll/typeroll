import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../../lib/access';
import { privateMediaReadUrl } from '../../../../../../lib/publishing/media-storage';
import { connectionFailure } from '../../../../../../lib/publishing/http';

export const GET: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  try {
    const url = await privateMediaReadUrl(guard.value.owner_org_id, guard.value.site.id, context.params.mediaId!);
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (error) { return connectionFailure(error); }
};
