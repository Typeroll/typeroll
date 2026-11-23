import { deleteMediaBatch, MAX_MEDIA_DELETE_BATCH } from '../../../../../../lib/media-batch-deletion';
import { validMediaId } from '../../../../../../lib/media/public-copies';
// GET /api/v1/sites/{siteId}/media
//
// Lists uploaded media items (CDN URLs + metadata). Pagination via ?limit=
// + ?cursor=. Cap 200.

import { mediaPreparationStatus } from '../../../../../../lib/media/preparation';
import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Media } from '@typeroll/shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(c: { after_id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(s: string | null): { after_id: string } | null {
  if (!s) return null;
  try {
    const d = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return typeof d?.after_id === 'string' ? { after_id: d.after_id } : null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  let items = await getStore().listDocs<Media>(paths.media(ctx.orgId, ctx.siteId));
  // Most-recent first; the cursor walks backwards through this stable order.
  items.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.id.localeCompare(b.id));
  if (cursor) {
    const idx = items.findIndex((i) => i.id === cursor.after_id);
    items = idx >= 0 ? items.slice(idx + 1) : items;
  }
  const slice = items.slice(0, limit);
  const nextCursor = items.length > limit ? encodeCursor({ after_id: slice[slice.length - 1]!.id }) : null;
  return apiResponse(ctx, { media: slice, next_cursor: nextCursor, preparation: await mediaPreparationStatus(ctx.orgId, ctx.siteId) });
};

/** DELETE with an explicit bounded list; never a whole-library deletion. */
export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('Extension installation credentials cannot delete media.', 403, ctx, { code: 'extension_media_delete_refused' });
  if (ctx.permission === 'read') return apiError('Media changes require write permission.', 403, ctx);
  let body: any;
  try { body = await request.json(); } catch { return apiError('Provide a JSON object with media_ids.', 400, ctx); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'media_ids') ||
    !Array.isArray(body.media_ids) || !body.media_ids.length || body.media_ids.length > MAX_MEDIA_DELETE_BATCH ||
    body.media_ids.some((id: unknown) => !validMediaId(id)) || new Set(body.media_ids).size !== body.media_ids.length)
    return apiError(`media_ids must contain 1–${MAX_MEDIA_DELETE_BATCH} distinct media ids.`, 400, ctx);
  const result = await deleteMediaBatch(ctx.orgId, ctx.siteId, body.media_ids, ctx.personalUserId ?? ctx.keyPrefix ?? null);
  return apiResponse(ctx, result, result.complete ? 200 : 207);
};
