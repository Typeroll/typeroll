// GET  /api/v1/sites/{siteId}/collections/{name}/items
// POST /api/v1/sites/{siteId}/collections/{name}/items     create
//
// Listing supports ?status= and ?limit= (default 50, max 200) and
// ?cursor=<opaque>. Fields not in the collection schema are silently
// dropped on create to keep the data shape stable (same policy as the
// in-app editor).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../lib/version-store';
import { getStore } from '../../../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { CollectionItem } from '@typeroll/shared';

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
  const name = params.name;
  if (!name) return apiError('Missing name');
  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError('Collection not found', 404);

  const url = new URL(request.url);
  const status = (url.searchParams.get('status') ?? 'all').trim();
  const summary = url.searchParams.get('summary') === 'true';
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  let items = await vstore.collectionItems(ctx.orgId, ctx.siteId, ctx.versionId, name);
  items.sort((a, b) => a.id.localeCompare(b.id));
  if (status !== 'all') items = items.filter((i) => i.status === status);
  if (cursor) {
    const idx = items.findIndex((i) => i.id === cursor.after_id);
    items = idx >= 0 ? items.slice(idx + 1) : items;
  }
  const slice = items.slice(0, limit);
  const nextCursor = items.length > limit ? encodeCursor({ after_id: slice[slice.length - 1]!.id }) : null;

  // Summary mode drops the schema's richtext fields so a 1000-item listing
  // doesn't blow the agent's context. The full item is one read_collection_item
  // away. Detection is schema-driven: any field with type === 'richtext' or
  // 'textarea' is dropped from the projection (their text equivalents
  // 'text', 'email', 'tel', 'number' etc. stay).
  if (summary) {
    const richFields = new Set(
      coll.fields.filter((f) => f.type === 'richtext' || f.type === 'textarea').map((f) => f.name),
    );
    const summarised = slice.map((item) => {
      const out = { ...item } as Record<string, unknown>;
      for (const f of richFields) {
        if (typeof out[f] === 'string') {
          const v = out[f] as string;
          // Replace with a length hint so the caller knows the field exists
          // and is non-trivial — useful for deciding whether to fetch the
          // full item.
          out[f] = { _summary_bytes: v.length };
        }
      }
      return out;
    });
    return apiResponse(ctx, { items: summarised, next_cursor: nextCursor });
  }
  return apiResponse(ctx, { items: slice, next_cursor: nextCursor });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const name = params.name;
  if (!name) return apiError('Missing name');
  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError('Collection not found', 404);
  const body = (await request.json().catch(() => null)) as { fields?: Record<string, unknown>; status?: string } | null;
  if (!body || typeof body.fields !== 'object' || !body.fields) {
    return apiError('Body must be { fields: { ... } }');
  }

  // Schema-allowlist the fields.
  const allowed = new Set(coll.fields.map((f) => f.name));
  const status = (body.status as 'draft' | 'published') ?? 'draft';
  const now = new Date().toISOString();
  const item: Record<string, unknown> = { status, created_at: now, updated_at: now };
  for (const [k, v] of Object.entries(body.fields)) {
    if (allowed.has(k)) item[k] = v;
  }

  const itemId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await getStore().setDoc(paths.collectionItem(ctx.orgId, ctx.siteId, name, itemId, ctx.versionId), item);
  const created = await vstore.collectionItem(ctx.orgId, ctx.siteId, ctx.versionId, name, itemId);
  return apiResponse(ctx, { item: created }, 201, body);
};
