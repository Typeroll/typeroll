// GET /api/sites/{siteId}/readiness — the portal's launch readiness panel.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { siteReadinessReport } from '../../../../lib/site-readiness-load';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id: orgId } = guard.value;
  try {
    return json(await siteReadinessReport(getStore(), orgId, site, versionId));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Readiness check failed' }, 400);
  }
};
