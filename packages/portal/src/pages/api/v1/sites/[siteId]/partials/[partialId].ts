// GET    /api/v1/sites/{siteId}/partials/{partialId}   — draft view
// PATCH  /api/v1/sites/{siteId}/partials/{partialId}   — shallow merge → working copy
// PUT    /api/v1/sites/{siteId}/partials/{partialId}   — full content replace → working copy
// DELETE /api/v1/sites/{siteId}/partials/{partialId}
//
// Buffer model: content writes land in the partial's WORKING COPY; `status`
// applies immediately; pass `save: true` to commit in the same call.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { applyContentWrite, type ContentWriteResult } from '../../../../../../lib/content-write';
import {
  discardWorkingCopy,
  overlayWorkingCopy,
  readWorkingCopy,
  WorkingCopyError,
} from '../../../../../../lib/working-copy';
import { ensureBlockIds } from '@typeroll/shared';
import type { Partial as PartialDoc } from '@typeroll/shared';

const WRITABLE: Array<keyof PartialDoc> = ['name', 'kind', 'html_content', 'status', 'blocks'];

function project(p: PartialDoc, hasUnsaved: boolean): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    content_mode: p.content_mode,
    ...(p.content_mode === 'blocks'
      ? { blocks: p.blocks ?? [] }
      : { html_content: p.html_content ?? '' }),
    date_updated: p.date_updated,
    has_unsaved_changes: hasUnsaved,
  };
}

function pickWritable(body: Partial<PartialDoc>): Partial<PartialDoc> {
  const out: Partial<PartialDoc> = {};
  for (const k of WRITABLE) {
    if (body[k] !== undefined) (out as Record<string, unknown>)[k] = body[k];
  }
  if (Array.isArray(out.blocks)) {
    out.blocks = ensureBlockIds(out.blocks);
  }
  return out;
}

async function draftView(
  ctx: { orgId: string; siteId: string; versionId: string },
  partialId: string,
): Promise<{ partial: PartialDoc; hasUnsaved: boolean } | null> {
  const doc = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  const wc = await readWorkingCopy(ctx, { kind: 'partial', id: partialId });
  if (!doc && !wc) return null;
  // A working copy can precede the saved doc (create-on-write partials).
  const base: PartialDoc = doc ?? {
    id: partialId,
    name: partialId,
    kind: partialId === 'header' || partialId === 'footer' ? partialId : 'free',
    content_mode: 'html',
    status: 'draft',
    html_content: '',
  };
  return { partial: overlayWorkingCopy(base, wc), hasUnsaved: !!wc };
}

function writeResponse(
  view: { partial: PartialDoc; hasUnsaved: boolean } | null,
  result: ContentWriteResult,
): Record<string, unknown> {
  return {
    partial: view ? project(view.partial, view.hasUnsaved) : null,
    saved: result.committed,
    staged_fields: result.staged,
    applied_immediately: result.applied_immediately,
    sanitization_warnings: result.sanitization_warnings,
    sanitization_details: result.sanitization_details,
  };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = params.partialId;
  if (!partialId) return apiError('Missing partialId');
  const view = await draftView(ctx, partialId);
  if (!view) return apiError('Not found', 404);
  return apiResponse(ctx, { partial: project(view.partial, view.hasUnsaved) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = params.partialId;
  if (!partialId) return apiError('Missing partialId');
  const existing = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as (Partial<PartialDoc> & { save?: boolean }) | null;
  if (!body) return apiError('Invalid JSON body');
  if (body.content_mode !== undefined) {
    return apiError('content_mode cannot be changed with PATCH; use POST /partials/{partialId}/mode', 400);
  }
  const update = pickWritable(body);
  if (Object.keys(update).length === 0) return apiError('No writable fields in body');
  try {
    const result = await applyContentWrite(
      ctx, { kind: 'partial', id: partialId }, update,
      { save: body.save === true, updatedBy: `api-key:${ctx.keyPrefix}` },
    );
    return apiResponse(ctx, writeResponse(await draftView(ctx, partialId), result), 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  // Functions like PATCH with html_content required — partials have no
  // system fields PUT needs to preserve. Header/footer auto-create with
  // their kind set (at commit).
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = params.partialId;
  if (!partialId) return apiError('Missing partialId');
  const body = (await request.json().catch(() => null)) as (Partial<PartialDoc> & { save?: boolean }) | null;
  if (!body) return apiError('Invalid JSON body');
  if (body.content_mode !== undefined) {
    return apiError('content_mode cannot be changed with PUT; use POST /partials/{partialId}/mode', 400);
  }
  if (typeof body.html_content !== 'string') return apiError('html_content required for PUT');
  const update = pickWritable(body);
  try {
    const result = await applyContentWrite(
      ctx, { kind: 'partial', id: partialId }, update,
      { save: body.save === true, updatedBy: `api-key:${ctx.keyPrefix}` },
    );
    return apiResponse(ctx, writeResponse(await draftView(ctx, partialId), result), 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = params.partialId;
  if (!partialId) return apiError('Missing partialId');
  if (partialId === 'header' || partialId === 'footer') {
    return apiError('header and footer can be PATCHed/PUT but not deleted — they are layout blocks', 400);
  }
  const existing = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  if (!existing) return apiError('Not found', 404);
  await vstore.deletePartial(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  await discardWorkingCopy(ctx, { kind: 'partial', id: partialId });
  return apiResponse(ctx, { ok: true });
};
