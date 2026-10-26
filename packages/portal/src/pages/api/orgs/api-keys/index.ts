// Org-scoped API key management. Mirrors /api/sites/{siteId}/api-keys but
// keys created here have null site_id and the lookup index resolves them
// to the full owned + shared-in site list at auth time. The public-API
// equivalent is /api/v1/organization/api-keys.

import type { APIRoute } from 'astro';
import { requireOrganizationOwnerOrAdmin, json } from '../../../../lib/access';
import { apiKeySummary, createApiKey, createdApiKeyResponse, listApiKeys, parseApiKeyName } from '../../../../lib/api-keys';

/** Organization owners and admins only, whether or not the organization
 *  enforces member roles. An org-scoped key acts as admin over every owned
 *  and shared-in site and over organization connections, so an editor who
 *  could mint one would bypass every role check. */
const ORG_API_KEY_REFUSAL = 'Only organization owners and admins can manage organization API keys.';

export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, ORG_API_KEY_REFUSAL);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const keys = await listApiKeys(session.orgId, null);
  return json({ keys: keys.map(apiKeySummary) });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, ORG_API_KEY_REFUSAL);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  const parsed = parseApiKeyName(await request.json().catch(() => ({})));
  if ('error' in parsed) return json({ error: parsed.error }, 400);

  const result = await createApiKey({
    orgId: session.orgId,
    siteId: null,
    name: parsed.name,
    createdBy: session.email ?? 'unknown',
  });

  return json(createdApiKeyResponse(result));
};
