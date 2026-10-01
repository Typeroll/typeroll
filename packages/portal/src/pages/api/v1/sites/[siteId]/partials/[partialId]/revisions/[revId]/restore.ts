// POST /api/v1/sites/{siteId}/partials/{partialId}/revisions/{revId}/restore
//   body: { save?: boolean }
//
// Restores a partial revision's content (name and HTML or block tree) through
// the same draft write path as PUT /partials/{partialId}: the revision
// replaces the partial's working copy, and `save: true` commits it. The
// commit snapshots the current saved partial first, so the restore is itself
// undoable. Publication status and kind are left as they are. A revision
// saved in the other content mode is refused; switch modes first with
// POST .../mode so the structural change is explicit.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../../lib/version-store';
import { getRevision } from '../../../../../../../../../lib/revisions';
import { applyContentWrite } from '../../../../../../../../../lib/content-write';
import { readWorkingCopy, WorkingCopyError } from '../../../../../../../../../lib/working-copy';
import { pathParam } from '../../../../../../../../../lib/path-param';
import { ensureBlockIds } from '@typeroll/shared';
import type { Partial as PartialDoc } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = pathParam(params.partialId);
  const revId = pathParam(params.revId);
  if (!partialId || !revId) return apiError('Missing partialId or revId', 400, ctx);
  const body = (await request.json().catch(() => ({}))) as { save?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);

  const existing = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  if (!existing) return apiError('Partial not found', 404, ctx);
  const rev = await getRevision({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'partial', resourceIds: [partialId], revId });
  if (!rev) return apiError('Revision not found', 404, ctx);

  const doc = rev.doc as Partial<PartialDoc>;
  const revMode = doc.content_mode ?? 'html';
  const currentMode = existing.content_mode ?? 'html';
  if (revMode !== currentMode) {
    return apiError(
      `Revision ${revId} was saved in ${revMode} mode but the partial is in ${currentMode} mode. Switch with POST /api/v1/sites/{siteId}/partials/{partialId}/mode first, then restore.`,
      409,
      ctx,
    );
  }

  const update: Record<string, unknown> = currentMode === 'blocks'
    ? { blocks: ensureBlockIds(Array.isArray(doc.blocks) ? doc.blocks : []) }
    : { html_content: typeof doc.html_content === 'string' ? doc.html_content : '' };
  if (typeof doc.name === 'string' && doc.name) update.name = doc.name;

  try {
    const save = body.save === true;
    const result = await applyContentWrite(ctx, { kind: 'partial', id: partialId }, update, { save, updatedBy: `api-key:${ctx.keyPrefix}` });
    const unsaved = !!(await readWorkingCopy(ctx, { kind: 'partial', id: partialId }));
    return apiResponse(ctx, {
      restored_revision: revId,
      saved: result.committed,
      has_unsaved_changes: unsaved,
      staged_fields: result.staged,
      sanitization_warnings: result.sanitization_warnings,
    }, 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status, ctx);
    throw e;
  }
};
