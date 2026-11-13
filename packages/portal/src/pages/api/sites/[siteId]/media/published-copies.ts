// Remove published copies of already-deleted media (portal session).
// Same behavior and authority as POST /api/v1/sites/{siteId}/media/published-copies:
// lib/media-deletion.ts → removePublishedMediaCopies. Owner-organization admins only.
import type { APIRoute } from 'astro';
import { requireSiteAccess, requireSiteLifecycleChange, json } from '../../../../../lib/access';
import { removePublishedMediaCopies } from '../../../../../lib/media-deletion';
import { connectionFailure } from '../../../../../lib/publishing/http';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  // Owner-organization admin, as for media purge; archived sites may clean up too.
  const allowed = requireSiteLifecycleChange(guard.value);
  if (!allowed.ok) return allowed.response;
  const { site, owner_org_id, session } = guard.value;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON body' }, 400);
  try {
    const outcome = await removePublishedMediaCopies(owner_org_id, site.id, body, { actor: session.userId ?? null });
    return json(outcome.body, outcome.status);
  } catch (error) {
    return connectionFailure(error);
  }
};
