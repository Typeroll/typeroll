import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionFailure } from '../../../../lib/publishing/http';
import { listOrganizationPublishingZones } from '../../../../lib/publishing/organization-domain-setup';

export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await listOrganizationPublishingZones(guard.value.orgId)); }
  catch (error) { return connectionFailure(error); }
};
