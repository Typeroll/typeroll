// GET /api/v1/sites/{siteId}/block-types/{typeId}/usage
//
// Pages that use a block of this type. Today's pages are HTML-mode so the
// result is always empty — when block-mode pages exist, this scans their
// blocks tree for matches. Shape locked in now so future block-editor work
// drops in cleanly.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import type { Block } from '@typeroll/shared';

function blocksContainType(blocks: Block[] | undefined, typeId: string): boolean {
  if (!Array.isArray(blocks)) return false;
  for (const b of blocks) {
    if (b.type === typeId) return true;
    if (b.children && blocksContainType(b.children, typeId)) return true;
    if (Array.isArray(b.slots)) {
      for (const slot of b.slots) {
        if (blocksContainType(slot, typeId)) return true;
      }
    }
  }
  return false;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = params.typeId;
  if (!typeId) return apiError('Missing typeId');

  const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
  const matches = pages
    .filter((p) => p.content_mode === 'blocks' && blocksContainType(p.blocks, typeId))
    .map((p) => ({ page_id: p.id, title: p.title, slug: p.slug, status: p.status }));
  return apiResponse(ctx, { type_id: typeId, pages: matches });
};
