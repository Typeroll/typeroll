// GET: returns the URL inventory with computed status. Coverage is
// re-classified on every request from current pages + redirects, so the
// numbers are always fresh.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { analyzeCoverage } from '../../../../../lib/wp/url-inventory';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const result = await analyzeCoverage(getStore(), owner_org_id, site.id);
  return json(result);
};
