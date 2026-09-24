// POST /api/v1/sites/{siteId}/pages/{pageId}/mode
//   body: { to: 'blocks' | 'html', convert?: boolean }
//
// Public API mirror of /api/sites/.../mode for MCP/agent use. Always
// snapshots a revision before flipping content_mode. convert=true is
// refused: this route never rewrites an HTML body into blocks.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import { snapshotRevision } from '../../../../../../../lib/revisions';
import { AUTOMATIC_CONVERSION_REFUSAL } from '../../../../../../../lib/html-to-blocks';
import type { Page } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');

  const body = await request.json().catch(() => null) as {
    to?: 'blocks' | 'html';
    convert?: boolean;
  } | null;
  if (!body?.to || (body.to !== 'blocks' && body.to !== 'html')) {
    return apiError('body.to must be "blocks" or "html"');
  }
  if (body.convert) return apiError(AUTOMATIC_CONVERSION_REFUSAL, 400);

  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return apiError('Not found', 404);
  if (page.content_mode === body.to) {
    return apiResponse(ctx, { ok: true, content_mode: body.to, unchanged: true });
  }

  await snapshotRevision({
    orgId: ctx.orgId,
    siteId: ctx.siteId,
    versionId: ctx.versionId,
    kind: 'page',
    resourceIds: [pageId],
    doc: page as unknown as Record<string, unknown>,
    createdBy: 'api',
    note: `Pre-mode-switch: ${page.content_mode} → ${body.to}`,
  });

  const update: Partial<Page> = { content_mode: body.to };
  if (body.to === 'blocks') {
    update.blocks = page.blocks ?? [];
  } else {
    update.blocks = [];
    update.html_content = page.html_content ?? '';
  }

  await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, pageId, update);
  return apiResponse(ctx, {
    ok: true,
    content_mode: body.to,
    converted: false,
  });
};
