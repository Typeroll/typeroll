// Org-scoped API key management. Mirrors /api/sites/{siteId}/api-keys but
// keys created here have null site_id and the lookup index resolves them
// to the full owned + shared-in site list at auth time. The public-API
// equivalent is /api/v1/organization/api-keys.

import type { APIRoute } from 'astro';
import { requireFullSession, requireOrgAdmin, json } from '../../../../lib/access';
import { apiKeySummary, createApiKey, createdApiKeyResponse, listApiKeys, parseApiKeyName } from '../../../../lib/api-keys';

export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const keys = await listApiKeys(session.orgId, null);
  return json({ keys: keys.map(apiKeySummary) });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  // Minting an org-scoped key grants admin over every owned + shared-in
  // site, so it must not be reachable below org-admin — otherwise it's a
  // clean bypass of the site-level role check.
  const adminCheck = await requireOrgAdmin(guard.value);
  if (!adminCheck.ok) return adminCheck.response;
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
