import type { APIRoute } from 'astro';
import { json, requireFullSession } from '../../../lib/access';
import { readOrganizationAccess } from '../../../lib/organization-access';
export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const response = json({ access: await readOrganizationAccess(guard.value.orgId) });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
