import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../../../lib/publishing/http';
import { managedMigrationPlan, migrateManagedSite } from '../../../../../../lib/publishing/managed-migration';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  try { return apiResponse(guard.value, await managedMigrationPlan(guard.value.orgId, guard.value.siteId)); }
  catch (error) { return connectionFailure(error); }
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return apiError('Publishing migration requires admin permission on the site.', 403);
  try { return apiResponse(guard.value, await migrateManagedSite(guard.value.orgId, guard.value.siteId, await publishingJsonBody(request))); }
  catch (error) { return connectionFailure(error); }
};
