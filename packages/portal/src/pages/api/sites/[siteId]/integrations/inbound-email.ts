import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { DeliveryError } from '../../../../../lib/email/delivery';
import { setInboundRoute, siteInboundRoutes } from '../../../../../lib/email/inbound';
const handle: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const { owner_org_id, site } = guard.value;
  try {
    if (request.method === 'PUT') {
      const body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid incoming email settings' }, 400);
      await setInboundRoute(owner_org_id, site.id, body);
    }
    return json({ routes: await siteInboundRoutes(owner_org_id, site.id) });
  } catch (error) {
    return json({ error: error instanceof DeliveryError ? error.message : 'Incoming email configuration is unavailable' }, error instanceof DeliveryError ? error.status : 503);
  }
};
export const GET = handle;
export const PUT = handle;
