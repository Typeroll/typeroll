// Revoke a single org-scoped key. Mirrors /api/sites/.../api-keys/[prefix]
// for org-scoped tokens. Soft-deletes the canonical metadata doc and
// hard-revokes the lookup index entry so the key stops authing immediately.

import type { APIRoute } from 'astro';
import { requireFullSession, requireOrgAdmin, json } from '../../../../lib/access';
import { revokeApiKey } from '../../../../lib/api-keys';

export const DELETE: APIRoute = async ({ cookies, params }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const adminCheck = await requireOrgAdmin(guard.value);
  if (!adminCheck.ok) return adminCheck.response;
  const session = guard.value;
  const { prefix } = params;
  if (!prefix) return json({ error: 'Missing prefix' }, 400);
  await revokeApiKey(session.orgId, null, prefix);
  return json({ ok: true });
};
