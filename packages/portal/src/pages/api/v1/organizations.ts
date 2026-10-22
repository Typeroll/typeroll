import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse } from '../../../lib/api-auth';
import { personalOrganizations } from '../../../lib/personal-site-access';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, { organizations: ctx.personalUserId
    ? await personalOrganizations(ctx.personalUserId)
    : [{ id: ctx.tokenOrgId, permission: ctx.tokenSiteId === null ? 'admin' : 'site' }],
  });
};
