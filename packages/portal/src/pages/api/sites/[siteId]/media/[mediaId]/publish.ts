import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../../lib/access';
import { connectionFailure } from '../../../../../../lib/publishing/http';
import { publishMediaFile } from '../../../../../../lib/media/file-publication';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const permission = requirePermission(guard.value, 'write');
  if (!permission.ok) return permission.response;
  if (request.headers.get('origin') !== new URL(process.env.PORTAL_PUBLIC_URL || request.url).origin) return json({ error: 'A same-origin request is required.' }, 403);
  if (!params.mediaId) return json({ error: 'Missing mediaId' }, 400);
  try { return json(await publishMediaFile(guard.value.owner_org_id, guard.value.site.id, params.mediaId)); }
  catch (error) { return connectionFailure(error); }
};
