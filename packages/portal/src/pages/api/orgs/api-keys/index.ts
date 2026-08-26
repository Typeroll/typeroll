// Org-scoped API key management. Mirrors /api/sites/{siteId}/api-keys but
// keys created here have null site_id and the lookup index resolves them
// to the full owned + shared-in site list at auth time.

import type { APIRoute } from 'astro';
import { requireFullSession, requireOrgAdmin, json } from '../../../../lib/access';
import { createApiKey, listApiKeys } from '../../../../lib/api-keys';

export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const keys = await listApiKeys(session.orgId, null);
  return json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      created_at: k.created_at,
      created_by: k.created_by,
      last_used_at: k.last_used_at,
      last_used_ip: k.last_used_ip,
      revoked_at: k.revoked_at,
    })),
  });
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

  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? '').trim();
  if (!name) return json({ error: 'name required' }, 400);
  if (name.length > 80) return json({ error: 'name too long (max 80 chars)' }, 400);

  const result = await createApiKey({
    orgId: session.orgId,
    siteId: null,
    name,
    createdBy: session.email ?? 'unknown',
  });

  return json({
    key: {
      id: result.key.id,
      name: result.key.name,
      created_at: result.key.created_at,
      created_by: result.key.created_by,
    },
    token: result.token,
  });
};
