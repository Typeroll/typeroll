// GET /api/v1/sites/{siteId}/media
//
// Lists uploaded media items (CDN URLs + metadata). Pagination via ?limit=
// + ?cursor=. Cap 200.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
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
  return apiResponse(ctx, { media: slice, next_cursor: nextCursor });
};
