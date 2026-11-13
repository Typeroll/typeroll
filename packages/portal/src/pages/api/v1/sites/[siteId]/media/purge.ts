// POST /api/v1/sites/{siteId}/media/purge
//
// Delete every media object an ARCHIVED site owns — the API door of the
// portal's media purge (/api/sites/{siteId}/media/purge), backed by the same
// lib/media-deletion.ts → purgeSiteMedia. Irreversible, so it has the same
// preconditions: the site must be archived first, and only an owner-org admin
// may call it. Partial failure answers 207 with the retained records listed;
// calling again retries exactly those. One call handles at most
// SITE_MEDIA_PURGE_BATCH records (Worker subrequest budget); `remaining` > 0
// answers 207 too: call again, optionally with `{ "after": next }` to move past
// records that keep failing.

import type { APIRoute } from 'astro';
import { ARCHIVED_SITE_MESSAGE, isArchivedSite } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey, requireApiSiteLifecycleChange } from '../../../../../../lib/api-auth';
import { purgeSiteMedia, SITE_MEDIA_PURGE_BATCH, validPurgeCursor } from '../../../../../../lib/media-deletion';

export const POST: APIRoute = async ({ request, params }) => {
  // Archived sites refuse writes; this one exists only for archived sites.
  const guard = await requireApiKey(request, params.siteId, { allowArchivedWrites: true });
  if (!guard.ok) return guard.response;
  const allowed = await requireApiSiteLifecycleChange(guard.value);
  if (!allowed.ok) return allowed.response;
  const ctx = allowed.value;

  if (!isArchivedSite(ctx.site)) {
    return apiError(`Archive the site first. ${ARCHIVED_SITE_MESSAGE}`, 409, ctx);
  }

  const body = await request.json().catch(() => ({})) as { after?: unknown } | null;
  const after = body && typeof body === 'object' ? body.after : undefined;
  if (after !== undefined && after !== null && !validPurgeCursor(after)) return apiError('after must be the next value of a previous call.', 400, ctx);
  const result = await purgeSiteMedia(ctx.orgId, ctx.siteId, { limit: SITE_MEDIA_PURGE_BATCH, after: (after as string | null | undefined) ?? null });
  return apiResponse(ctx, result, result.complete ? 200 : 207, body ?? {});
};
