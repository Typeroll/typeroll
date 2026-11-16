// Before publishing: what blocks or slows the next publication of this
// version and how long it usually takes. The Publish menu shows the changes
// from changes-since-deploy, so the comparison itself is left out here.
import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../lib/access';
import { publicationPlan } from '../../../../lib/publishing/publication-plan';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id: orgId } = guard.value;
  try {
    const { impact: _impact, ...plan } = await publicationPlan(orgId, site.id, versionId);
    return json(plan);
  } catch { return json({ error: 'The publication plan could not be prepared.' }, 409); }
};
