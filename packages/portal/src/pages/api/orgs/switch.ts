import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../lib/access';
import { organizationMembership, rememberOrganization, selectOrganization } from '../../../lib/organization-session';

export const POST: APIRoute = async ({ cookies, request }) => {
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  let orgId: unknown;
  try { orgId = (await request.json()).orgId; } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (typeof orgId !== 'string') return json({ error: 'Organization is required' }, 400);
  const { userId } = guard.value;
  if (!await organizationMembership(userId, orgId)) return json({ error: 'Organization not found' }, 404);
  if (guard.value.orgId) await rememberOrganization(userId, guard.value.orgId);
  await rememberOrganization(userId, orgId);
  selectOrganization(cookies, userId, orgId);
  return json({ ok: true, orgId });
};
