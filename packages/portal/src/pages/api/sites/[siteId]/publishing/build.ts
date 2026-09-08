import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../lib/access';
import { customerBuildStatus } from '../../../../../lib/publishing/build-status';
import { privateJson, connectionFailure } from '../../../../../lib/publishing/http';

export const GET: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  try { return privateJson(await customerBuildStatus(guard.value.owner_org_id, guard.value.site.id, context.url.searchParams.get('job_id') ?? '')); }
  catch (error) { return connectionFailure(error); }
};
