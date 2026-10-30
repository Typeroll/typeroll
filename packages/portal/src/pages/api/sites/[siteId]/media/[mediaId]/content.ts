import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../../lib/access';
import { requireApiKey } from '../../../../../../lib/api-auth';
import { privateMediaReadUrl } from '../../../../../../lib/publishing/media-storage';
import { connectionFailure } from '../../../../../../lib/publishing/http';

// A private media item's cdn_url points here. Editors arrive with a session;
// API clients holding that URL send the same bearer key as /api/v1.
export const GET: APIRoute = async context => {
  let owner: { orgId: string; siteId: string };
  if (/^Bearer\s/i.test(context.request.headers.get('authorization') ?? '')) {
    const guard = await requireApiKey(context.request, context.params.siteId);
    if (!guard.ok) return guard.response;
    owner = { orgId: guard.value.orgId, siteId: guard.value.siteId };
  } else {
    const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
    if (!guard.ok) return guard.response;
    owner = { orgId: guard.value.owner_org_id, siteId: guard.value.site.id };
  }
  try {
    const url = await privateMediaReadUrl(owner.orgId, owner.siteId, context.params.mediaId!);
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (error) { return connectionFailure(error); }
};
