import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../lib/access';
import { privateJson } from '../../../../../lib/publishing/http';
import { publishingReadiness } from '../../../../../lib/publishing/readiness';

export const GET: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  return privateJson(await publishingReadiness(guard.value.owner_org_id, guard.value.site.id, guard.value.versionId));
};
