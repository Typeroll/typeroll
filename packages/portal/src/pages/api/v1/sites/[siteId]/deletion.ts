// GET  /api/v1/sites/{siteId}/deletion — what permanent deletion would remove,
//                                         what blocks it, what it leaves in your
//                                         own accounts, and the digest to confirm
// POST /api/v1/sites/{siteId}/deletion — { confirm_site_id, confirm_digest, reason? }
//
// Owner authority only (lib/api-auth.ts → requireApiOwnerAuthority): a personal
// connection of an owner of the organization that owns the site. The rules are
// in lib/site-deletion.ts. POST rather than DELETE /sites/{siteId}: the
// confirmation is a body, which DELETE carries unreliably through clients and
// proxies, and Core's other irreversible lifecycle actions (media/purge,
// lifecycle) are POSTs to a named sub-resource.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, requireApiOwnerAuthority, withApiIdentity } from '../../../../../lib/api-auth';
import { json } from '../../../../../lib/access';
import { deleteSite, siteDeletionInventory } from '../../../../../lib/site-deletion';

const ACTION = 'delete this site';
const confirmPath = (siteId: string) => `/api/v1/sites/${siteId}/deletion`;

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const allowed = await requireApiOwnerAuthority(guard.value, ACTION);
  if (!allowed.ok) return allowed.response;
  const ctx = allowed.value;
  return apiResponse(ctx, await siteDeletionInventory(ctx.orgId, ctx.site, confirmPath(ctx.siteId)));
};

export const POST: APIRoute = async ({ request, params }) => {
  // Archived sites refuse writes; deletion exists only for archived sites and
  // refuses an active one itself, with the other blockers.
  const guard = await requireApiKey(request, params.siteId, { allowArchivedWrites: true });
  if (!guard.ok) return guard.response;
  const allowed = await requireApiOwnerAuthority(guard.value, ACTION);
  if (!allowed.ok) return allowed.response;
  const ctx = allowed.value;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx, { code: 'invalid_body' });

  const outcome = await deleteSite({
    orgId: ctx.orgId,
    site: ctx.site,
    body,
    actor: { key_prefix: ctx.keyPrefix, ...(ctx.personalUserId ? { user_id: ctx.personalUserId } : {}) },
    confirmPath: confirmPath(ctx.siteId),
  });
  // Not apiResponse: its write audit would land beneath the site being
  // deleted. The deletion keeps its own audit record on the organization.
  return withApiIdentity(ctx, json(outcome.body, outcome.status));
};
