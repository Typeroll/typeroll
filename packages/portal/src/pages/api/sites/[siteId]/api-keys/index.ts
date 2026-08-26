// Management API for the site's public-API keys. Cookie-authed via the
// session — this is what the in-app settings UI talks to. The keys it
// creates are then presented as bearer tokens to /api/v1/* by external
// clients.
//
// Reads: list keys (metadata only; the plaintext secret has been
// unrecoverable since creation).
// Writes: create a new key (returns the plaintext token exactly once).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { createApiKey, listApiKeys } from '../../../../../lib/api-keys';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const keys = await listApiKeys(owner_org_id, site.id);
  // Strip the hash before returning — useful defense in depth even though
  // it's already a hash (the UI doesn't need it and exposing it offers
  // nothing).
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

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? '').trim();
  if (!name) return json({ error: 'name required' }, 400);
  if (name.length > 80) return json({ error: 'name too long (max 80 chars)' }, 400);

  const result = await createApiKey({
    orgId: owner_org_id,
    siteId: site.id,
    name,
    createdBy: session.email ?? 'unknown',
  });

  // The token is shown to the user once and never returned again. Persist
  // a small note in the audit log so we can see "Acme agency key was
  // created by admin@..." even after a rotation.
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
