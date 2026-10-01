// Management API for the site's public-API keys. Cookie-authed via the
// session — this is what the in-app settings UI talks to. The keys it
// creates are then presented as bearer tokens to /api/v1/* by external
// clients. The public-API equivalent is /api/v1/sites/{siteId}/api-keys;
// both share the projection and validation in lib/api-keys.
//
// Reads: list keys (metadata only; the plaintext secret has been
// unrecoverable since creation).
// Writes: create a new key (returns the plaintext token exactly once).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { apiKeySummary, createApiKey, createdApiKeyResponse, listApiKeys, parseApiKeyName } from '../../../../../lib/api-keys';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const keys = await listApiKeys(owner_org_id, site.id);
  return json({ keys: keys.map(apiKeySummary) });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;

  const parsed = parseApiKeyName(await request.json().catch(() => ({})));
  if ('error' in parsed) return json({ error: parsed.error }, 400);

  const result = await createApiKey({
    orgId: owner_org_id,
    siteId: site.id,
    name: parsed.name,
    createdBy: session.email ?? 'unknown',
  });

  // The token is shown to the user once and never returned again.
  return json(createdApiKeyResponse(result));
};
