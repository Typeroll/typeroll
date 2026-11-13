// Delete every media object a site owns.
//
// Gated on the site being archived, because this is irreversible and has
// exactly one legitimate caller: retiring a site for good. An archived site
// already refuses writes, so nothing can add media between this call and the
// operator destroying the rest.
//
// It lives in Core rather than the operator because the credentials do. An
// organization's media sits in that organization's own R2, reachable through
// the publishing connection and its encrypted credentials, which the operator
// deliberately cannot read.
//
// API keys use POST /api/v1/sites/{siteId}/media/purge (MCP
// `purge_site_media`) with the same preconditions.
import type { APIRoute } from 'astro';
import { ARCHIVED_SITE_MESSAGE, isArchivedSite } from '@typeroll/shared';
import { requireSiteAccess, requireSiteLifecycleChange, json } from '../../../../../lib/access';
import { purgeSiteMedia, SITE_MEDIA_PURGE_BATCH, validPurgeCursor } from '../../../../../lib/media-deletion';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  // Same authority as archiving: owner-org admins only. Not requirePermission,
  // which refuses every write on an archived site — including this one.
  const allowed = requireSiteLifecycleChange(guard.value);
  if (!allowed.ok) return allowed.response;
  const { site, owner_org_id } = guard.value;

  if (!isArchivedSite(site)) {
    return json({ error: `Archive the site first. ${ARCHIVED_SITE_MESSAGE}` }, 409);
  }

  // One call handles at most SITE_MEDIA_PURGE_BATCH records (Worker
  // subrequest budget); `remaining` says how many are left for the next call,
  // and `{ "after": next }` moves past records that keep failing.
  const body = await request.json().catch(() => ({})) as { after?: unknown } | null;
  const after = body && typeof body === 'object' ? body.after : undefined;
  if (after !== undefined && after !== null && !validPurgeCursor(after)) return json({ error: 'after must be the next value of a previous call.' }, 400);
  const result = await purgeSiteMedia(owner_org_id, site.id, { limit: SITE_MEDIA_PURGE_BATCH, after: (after as string | null | undefined) ?? null });
  // Partial failure is a real outcome, not an error: the objects that went are
  // gone, their records are removed, and the rest are retained for a retry.
  return json(result, result.complete ? 200 : 207);
};
