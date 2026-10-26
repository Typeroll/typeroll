// Revoke a single org-scoped key. Mirrors /api/sites/.../api-keys/[prefix]
// for org-scoped tokens. Soft-deletes the canonical metadata doc and
// hard-revokes the lookup index entry so the key stops authing immediately.

import type { APIRoute } from 'astro';
import { requireOrganizationOwnerOrAdmin, json } from '../../../../lib/access';
import { revokeApiKey } from '../../../../lib/api-keys';

const ORG_API_KEY_REFUSAL = 'Only organization owners and admins can manage organization API keys.';

export const DELETE: APIRoute = async ({ cookies, params }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, ORG_API_KEY_REFUSAL);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const { prefix } = params;
  if (!prefix) return json({ error: 'Missing prefix' }, 400);
  await revokeApiKey(session.orgId, null, prefix);
  return json({ ok: true });
};
