// POST /api/v1/sites/{siteId}/pages/{pageId}/revisions/{revId}/restore
//   body: { save?: boolean }
//
// Restores a revision's content through the same draft write path as PUT:
// the revision's content fields replace the page's working copy, and
// `save: true` commits it (which snapshots the current saved page first, so
// the restore is itself undoable). Publication state (status and schedule)
// is left as it is. A revision saved in the other content mode is refused;
// switch modes first with POST .../mode so the structural change is explicit.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../../lib/version-store';
import { getRevision } from '../../../../../../../../../lib/revisions';
import { applyContentWrite } from '../../../../../../../../../lib/content-write';
import { readWorkingCopy, WorkingCopyError } from '../../../../../../../../../lib/working-copy';
import { pickWritable, REPLACEABLE } from '../../../../../../../../../lib/page-writable';
import type { Page } from '@typeroll/shared';

const KEEP_CURRENT: Array<keyof Page> = ['status', 'content_mode', 'date_published', 'publish_at', 'unpublish_at'];

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { pageId, revId } = params;
  if (!pageId || !revId) return apiError('Missing pageId or revId');
  const body = (await request.json().catch(() => ({}))) as { save?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body');

  const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!existing) return apiError('Page not found', 404);
  const rev = await getRevision({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'page', resourceIds: [pageId], revId });
  if (!rev) return apiError('Revision not found', 404);

  const doc = rev.doc as Partial<Page>;
  const revMode = doc.content_mode ?? 'html';
  const currentMode = existing.content_mode ?? 'html';
  if (revMode !== currentMode) {
    return apiError(
      `Revision ${revId} was saved in ${revMode} mode but the page is in ${currentMode} mode. Switch with POST /api/v1/sites/{siteId}/pages/{pageId}/mode first, then restore.`,
      409,
    );
  }

  const update: Record<string, unknown> = pickWritable(doc);
  for (const key of KEEP_CURRENT) delete update[key];
  for (const key of REPLACEABLE) if (!(key in update)) update[key] = null;
  update.fields = {
    ...Object.fromEntries(Object.keys(existing.fields ?? {}).map((key) => [key, null])),
    ...(doc.fields ?? {}),
  };

  try {
    const save = body.save === true;
    const result = await applyContentWrite(ctx, { kind: 'page', id: pageId }, update, { save, updatedBy: `api-key:${ctx.keyPrefix}` });
    const unsaved = !!(await readWorkingCopy(ctx, { kind: 'page', id: pageId }));
    return apiResponse(ctx, {
      restored_revision: revId,
      saved: result.committed,
      has_unsaved_changes: unsaved,
      staged_fields: result.staged,
      sanitization_warnings: result.sanitization_warnings,
      seo_warnings: result.seo_warnings,
      auto_redirects: result.auto_redirects,
      retired_redirects: result.retired_redirects,
    }, 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};
