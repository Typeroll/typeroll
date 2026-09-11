import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { privateJson, connectionBody, connectionFailure } from '../../../../../lib/publishing/http';
import { managedMigrationPlan, migrateManagedSite } from '../../../../../lib/publishing/managed-migration';

export const GET: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  try { return privateJson(await managedMigrationPlan(guard.value.owner_org_id, guard.value.site.id)); }
  catch (error) { return connectionFailure(error); }
};

export const POST: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  try { return privateJson(await migrateManagedSite(guard.value.owner_org_id, guard.value.site.id, await connectionBody(context.request) as Record<string, unknown>)); }
  catch (error) { return connectionFailure(error); }
};
