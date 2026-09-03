// GET    /api/v1/sites/{siteId}/collections/{name}/items/{itemId} — draft view
// PATCH  — shallow merge → working copy; `status` immediate; `save: true` commits
// DELETE — remove item (and its working copy)

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../lib/version-store';
import { applyContentWrite } from '../../../../../../../../lib/content-write';
import {
  applyFieldAuthority,
  conflictResponse,
} from '../../../../../../../../lib/field-authority';
import {
  discardWorkingCopy,
  overlayWorkingCopy,
  readWorkingCopy,
  WorkingCopyError,
} from '../../../../../../../../lib/working-copy';
import type { CollectionDef, CollectionItem } from '@typeroll/shared';

async function resolveItem(
  ctx: { orgId: string; siteId: string; versionId: string },
  coll: CollectionDef,
  reference: string,
): Promise<{ item: CollectionItem; id: string; resolvedBy: 'id' | 'slug' } | null> {
  const direct = await vstore.collectionItem(ctx.orgId, ctx.siteId, ctx.versionId, coll.name, reference);
  if (direct) return { item: direct, id: direct.id, resolvedBy: 'id' };
  const slugField = coll.slug_field ?? 'slug';
  const items = await vstore.collectionItems(ctx.orgId, ctx.siteId, ctx.versionId, coll.name);
  const match = items.find((item) => String(item[slugField] ?? '') === reference);
  return match ? { item: match, id: match.id, resolvedBy: 'slug' } : null;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return apiError('Missing name or itemId');
  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError('Collection not found', 404);
  const resolved = await resolveItem(ctx, coll, itemId);
  if (!resolved) return apiError('Not found', 404);
  const wc = await readWorkingCopy(ctx, { kind: 'item', collection: name, id: resolved.id });
  const data = {
    item: overlayWorkingCopy(resolved.item, wc),
    resolved_by: resolved.resolvedBy,
    has_unsaved_changes: !!wc,
  };
  return apiResponse(ctx, { ...data, data });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return apiError('Missing name or itemId');
  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError('Collection not found', 404);
  const resolved = await resolveItem(ctx, coll, itemId);
  if (!resolved) return apiError('Not found', 404);
  const existing = resolved.item;

  const body = (await request.json().catch(() => null)) as {
    fields?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    status?: string;
    save?: boolean;
  } | null;
  if (!body) return apiError('Invalid JSON body');

  // Authority check happens HERE, before the fields are staged, so an agent
  // learns immediately that it lost a field rather than at commit time.
  // Provenance itself is stamped at commit (working copies whitelist to
  // schema field names, and a draft that's never committed shouldn't claim
  // authorship of a published value).
  const authority = applyFieldAuthority({
    fields: coll.fields,
    incoming: { ...(body.patch ?? body.fields ?? {}) },
    existing,
    actor: 'agent',
    actorId: `api-key:${ctx.keyPrefix}`,
  });
  if (authority.rejected.length > 0) {
    return apiResponse(ctx, conflictResponse(authority.rejected), 409, body);
  }

  const fields: Record<string, unknown> = { ...authority.update };
  if (body.status !== undefined) fields.status = body.status;
  try {
    const result = await applyContentWrite(
      ctx, { kind: 'item', collection: name, id: resolved.id }, fields,
      { save: body.save === true, updatedBy: `api-key:${ctx.keyPrefix}`, actor: 'agent' },
    );
    const fresh = await vstore.collectionItem(ctx.orgId, ctx.siteId, ctx.versionId, name, resolved.id);
    const wc = await readWorkingCopy(ctx, { kind: 'item', collection: name, id: resolved.id });
    const data = {
      item: fresh ? overlayWorkingCopy(fresh, wc) : null,
      resolved_by: resolved.resolvedBy,
      has_unsaved_changes: !!wc,
      saved: result.committed,
      staged_fields: result.staged,
      applied_immediately: result.applied_immediately,
    };
    return apiResponse(ctx, { ...data, data }, 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return apiError('Missing name or itemId');
  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError('Collection not found', 404);
  const resolved = await resolveItem(ctx, coll, itemId);
  if (!resolved) return apiError('Not found', 404);
  await vstore.deleteCollectionItem(ctx.orgId, ctx.siteId, ctx.versionId, name, resolved.id);
  await discardWorkingCopy(ctx, { kind: 'item', collection: name, id: resolved.id });
  return apiResponse(ctx, { ok: true, resolved_by: resolved.resolvedBy });
};
