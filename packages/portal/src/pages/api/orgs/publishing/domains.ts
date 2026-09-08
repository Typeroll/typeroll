import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionBody, connectionFailure } from '../../../../lib/publishing/http';
import { saveOrganizationDomains } from '../../../../lib/publishing/domain-config';

import { getOrganizationDomainStatus } from '../../../../lib/publishing/organization-domain-status';

export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await getOrganizationDomainStatus(guard.value.orgId)); }
  catch (error) { return connectionFailure(error); }
};

export const PUT: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    await saveOrganizationDomains(guard.value.orgId, await connectionBody(context.request) as Record<string, unknown>);
    return privateJson(await getOrganizationDomainStatus(guard.value.orgId));
  }
  catch (error) { return connectionFailure(error); }
};
