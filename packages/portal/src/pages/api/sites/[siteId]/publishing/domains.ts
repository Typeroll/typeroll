import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { privateJson, connectionBody, connectionFailure } from '../../../../../lib/publishing/http';
import { getSiteDomains, saveSiteDomains } from '../../../../../lib/publishing/domain-config';
import { siteDomainsWithChecks } from '../../../../../lib/publishing/host-checks';

export const GET: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  const orgId = guard.value.owner_org_id, siteId = guard.value.site.id;
  try { return privateJson(await siteDomainsWithChecks(orgId, siteId, await getSiteDomains(orgId, siteId), guard.value.versionId)); }
  catch (error) { return connectionFailure(error); }
};

export const PUT: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const orgId = guard.value.owner_org_id, siteId = guard.value.site.id;
  try { return privateJson(await siteDomainsWithChecks(orgId, siteId, await saveSiteDomains(orgId, siteId, await connectionBody(context.request) as Record<string, unknown>), guard.value.versionId)); }
  catch (error) { return connectionFailure(error); }
};
