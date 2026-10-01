// POST /api/sites/{siteId}/pages/{pageId}/blocks/convert-prose
//   { block_id }                       preview: the blocks a text block would become
//   { block_id, accept: <fingerprint> } replace the text block in the draft
//
// Session route for the block editor. Mirrors the v1 route of the same name.

import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../../../lib/access';
import { vstore } from '../../../../../../../lib/version-store';
import { mergeWorkingCopy, readWorkingCopy, type WcCtx } from '../../../../../../../lib/working-copy';
import { applyProseConversion, previewProseConversion, ProseConvertError } from '../../../../../../../lib/prose-convert';
import type { Block } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, versionId, owner_org_id } = guard.value;
  const pageId = params.pageId;
  if (!pageId) return json({ error: 'Missing pageId' }, 400);
  const body = await request.json().catch(() => null) as { block_id?: unknown; accept?: unknown } | null;
  if (typeof body?.block_id !== 'string' || !body.block_id) return json({ error: 'block_id required' }, 400);
  if (body.accept !== undefined && typeof body.accept !== 'string') return json({ error: 'accept must be the preview fingerprint' }, 400);

  const page = await vstore.page(owner_org_id, site.id, versionId, pageId);
  if (!page) return json({ error: 'Page not found' }, 404);
  const ctx: WcCtx = { orgId: owner_org_id, siteId: site.id, versionId };
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  const tree = (wc?.fields?.blocks as Block[] | undefined) ?? page.blocks ?? [];
  try {
    if (!body.accept) return json({ ...previewProseConversion(tree, body.block_id), applied: false });
    const { blocks, conversion } = applyProseConversion(tree, body.block_id, body.accept);
    await mergeWorkingCopy(ctx, { kind: 'page', id: pageId }, { blocks });
    return json({ ...conversion, blocks, applied: true });
  } catch (e) {
    if (e instanceof ProseConvertError) return json({ error: e.message }, e.status);
    throw e;
  }
};
