// POST /api/v1/sites/{siteId}/media/published-copies
//
// Remove published copies of media that is already deleted from the library:
// the objects a publication wrote into the organization's public bucket and
// the Cloudflare cache of their URLs. Body:
//   media_ids          deleted media ids; copies are found from their
//                      tombstones and this site's publication manifests
//   urls               exact public URLs on this site's media hosts
//   dry_run            true lists exactly what would be removed
//   scan_publications  false skips reading publication manifests
//   publications_after publications.next of a previous call: read the next
//                      batch of older publications
//   purge_prefixes     true also purges each copy's base by URL prefix
// Copies an existing media record still uses are never removed. Answers 200
// with `complete: true` only when everything requested was removed and
// purged; otherwise 207 with `incomplete_reasons` (an object, a lookup, an
// unrecognized key, a cache purge the Cloudflare connection may not make, an
// id or URL that was not found, publications not read yet); calling again
// retries what is left. lib/media-deletion.ts → removePublishedMediaCopies.
// MCP: remove_published_media_copies.
//
// Admin of the owning organization only, with the same guard as media/purge:
// shares, Extension installation credentials and site keys minted outside the
// owning organization are refused.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, requireApiSiteLifecycleChange } from '../../../../../../lib/api-auth';
import { removePublishedMediaCopies } from '../../../../../../lib/media-deletion';
import { connectionFailure } from '../../../../../../lib/publishing/http';

export const POST: APIRoute = async ({ request, params }) => {
  // Removing a deleted file's copies is cleanup, so archived sites may do it too.
  const guard = await requireApiKey(request, params.siteId, { allowArchivedWrites: true });
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const allowed = await requireApiSiteLifecycleChange(ctx);
  if (!allowed.ok) {
    return apiError('Removing published media copies requires an admin of the organization that owns the site.', 403, ctx, { code: 'admin_required' });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);
  try {
    const outcome = await removePublishedMediaCopies(ctx.orgId, ctx.siteId, body, { actor: ctx.personalUserId ?? ctx.keyPrefix ?? null });
    return apiResponse(ctx, outcome.body, outcome.status, body);
  } catch (error) {
    return connectionFailure(error);
  }
};
