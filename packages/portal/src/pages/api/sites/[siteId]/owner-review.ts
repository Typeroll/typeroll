import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission } from '../../../../lib/access';
import { handleOwnerReviewAdmin } from '../../../../lib/owner-review-http';
const handle: APIRoute = async ({ request, params, cookies, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const permission = requirePermission(guard.value, 'admin');
  if (!permission.ok) return permission.response;
  const { owner_org_id, site, versionId, session } = guard.value;
  return handleOwnerReviewAdmin({ orgId: owner_org_id, siteId: site.id, versionId }, session.userId, request);
};
export const GET = handle;
export const POST = handle;
