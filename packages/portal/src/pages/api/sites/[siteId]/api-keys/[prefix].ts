// Revoke an API key (mark, never delete — preserves audit history).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { revokeApiKey } from '../../../../../lib/api-keys';

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const prefix = params.prefix;
  if (!prefix) return json({ error: 'Missing prefix' }, 400);
  await revokeApiKey(owner_org_id, site.id, prefix);
  return json({ ok: true });
};
