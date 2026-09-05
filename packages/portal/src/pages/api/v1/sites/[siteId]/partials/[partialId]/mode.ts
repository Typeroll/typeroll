// POST /api/v1/sites/{siteId}/partials/{partialId}/mode
// body: { to: 'blocks' | 'html', convert?: boolean }

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import { snapshotRevision } from '../../../../../../../lib/revisions';
import { htmlToBlocks } from '../../../../../../../lib/html-to-blocks';
import type { Partial as PartialDoc } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = params.partialId;
  if (!partialId) return apiError('Missing partialId');
  const body = await request.json().catch(() => null) as { to?: 'blocks' | 'html'; convert?: boolean } | null;
  if (!body?.to || (body.to !== 'blocks' && body.to !== 'html')) {
    return apiError('body.to must be "blocks" or "html"', 400);
  }

  const partial = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  if (!partial) return apiError('Not found', 404);
  if (partial.content_mode === body.to) {
    return apiResponse(ctx, { ok: true, content_mode: body.to, unchanged: true });
  }

  await snapshotRevision({
    orgId: ctx.orgId,
    siteId: ctx.siteId,
    versionId: ctx.versionId,
    kind: 'partial',
    resourceIds: [partialId],
    doc: partial as unknown as Record<string, unknown>,
    createdBy: 'api',
    note: `Pre-mode-switch: ${partial.content_mode} → ${body.to}`,
  });

  const update: Partial<PartialDoc> = { content_mode: body.to };
  let converted = false;
  if (body.to === 'blocks') {
    if (body.convert && partial.html_content) {
      update.blocks = htmlToBlocks(partial.html_content).blocks;
      converted = true;
    } else {
      update.blocks = partial.blocks ?? [];
    }
  } else {
    update.html_content = partial.html_content ?? '';
  }
  await vstore.writePartial(ctx.orgId, ctx.siteId, ctx.versionId, partialId, update);
  const saved = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  return apiResponse(ctx, {
    ok: true,
    content_mode: saved?.content_mode,
    blocks: saved?.content_mode === 'blocks' ? saved.blocks ?? [] : undefined,
    converted,
  });
};
