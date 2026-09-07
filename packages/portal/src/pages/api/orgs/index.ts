import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../lib/access';
import { listOrganizations } from '../../../lib/organization-session';

export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  const response = json({ organizations: await listOrganizations(guard.value), active_org_id: guard.value.orgId ?? null });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
