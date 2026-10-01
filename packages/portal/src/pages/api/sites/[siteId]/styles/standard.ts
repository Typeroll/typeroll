// Portal (session) route: add missing standard styles, or reset them.
import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { applyStandardStyles, StyleError } from '../../../../../lib/site-styles-store';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const check = requirePermission(guard.value, 'write');
  if (!check.ok) return check.response;
  const body = (await request.json().catch(() => ({}))) as { overwrite?: unknown } | null;
  try {
    const { site, versionId, owner_org_id } = guard.value;
    return json(await applyStandardStyles({ orgId: owner_org_id, siteId: site.id, versionId }, { overwrite: body?.overwrite === true }));
  } catch (error) {
    if (error instanceof StyleError) return json({ error: error.message, errors: error.errors }, error.status);
    throw error;
  }
};
