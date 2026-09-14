import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { mediaPreparationStatus, requestMediaPreparation } from '../../../../../lib/media/preparation';
export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  return json(await mediaPreparationStatus(guard.value.owner_org_id, guard.value.site.id));
};
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  if (request.headers.get('origin') !== new URL(process.env.PORTAL_PUBLIC_URL || request.url).origin) return json({ error: 'Same-origin request required.' }, 403);
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const permission = requirePermission(guard.value, 'admin');
  if (!permission.ok) return permission.response;
  await requestMediaPreparation(guard.value.owner_org_id, guard.value.site.id);
  return json(await mediaPreparationStatus(guard.value.owner_org_id, guard.value.site.id));
};
