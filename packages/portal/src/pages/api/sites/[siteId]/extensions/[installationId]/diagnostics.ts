import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../../lib/access';
import { readExtensionDiagnostics } from '../../../../../../lib/extensions/diagnostics';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  if (!params.installationId) return json({ error: 'Missing installationId' }, 400);
  const diagnostics = await readExtensionDiagnostics(guard.value.owner_org_id, guard.value.site.id, params.installationId);
  if (!diagnostics) return json({ error: 'Installation not found' }, 404);
  return json(diagnostics);
};
