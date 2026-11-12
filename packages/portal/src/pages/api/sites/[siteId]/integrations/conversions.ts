// Cookie-auth, admin-only: form conversion status for the Integrations card
// (GET) and the Conversions API test send (POST { meta_event? }). The same
// data as GET/POST /api/v1/sites/{siteId}/integrations/conversions[/test].

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { conversionStatus, sendTestConversion } from '../../../../../lib/forms/conversions';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  return json(await conversionStatus(guard.value.owner_org_id, guard.value.site.id));
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const body = await request.json().catch(() => ({})) as { meta_event?: unknown };
  const result = await sendTestConversion({
    orgId: guard.value.owner_org_id,
    siteId: guard.value.site.id,
    metaEvent: typeof body?.meta_event === 'string' ? body.meta_event : undefined,
  });
  return json(result, result.ok ? 200 : result.entry ? 502 : 409);
};
