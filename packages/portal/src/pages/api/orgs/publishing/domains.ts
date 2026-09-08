import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionBody, connectionFailure } from '../../../../lib/publishing/http';
import { getOrganizationDomains, saveOrganizationDomains } from '../../../../lib/publishing/domain-config';

export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await getOrganizationDomains(guard.value.orgId)); }
  catch (error) { return connectionFailure(error); }
};

export const PUT: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await saveOrganizationDomains(guard.value.orgId, await connectionBody(context.request) as Record<string, unknown>)); }
  catch (error) { return connectionFailure(error); }
};
