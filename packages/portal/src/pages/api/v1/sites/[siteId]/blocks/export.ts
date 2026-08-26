// GET /api/v1/sites/{siteId}/blocks/export?ids=&name=&version=
//
// Public API mirror of /api/sites/{siteId}/blocks/export. Always returns
// JSON with zip_base64; the agent can decode and save locally if it wants
// the raw bytes. (Streaming the zip body via base64 is plenty efficient at
// the sizes this format targets — tens of KB per package.)

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths, type BlockType } from '@typeroll/shared';
import { packBlockTypes } from '../../../../../../lib/block-packages';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids');
  const wantedIds = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const pkgName = url.searchParams.get('name') ?? `${ctx.siteId}-blocks`;
  const pkgVersion = url.searchParams.get('version') ?? '1.0.0';

  const store = getStore();
  const basePath = paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId);
  const all = await store.listDocs<BlockType>(basePath);

  const filtered = wantedIds
    ? all.filter((bt) => wantedIds.includes(bt.id))
    : all.filter((bt) => (bt.origin ?? bt.created_by) === 'user');

  // Empty-export case: return an empty-but-valid response (block_count
  // 0, zip_base64 null) instead of 404. Lets agents build idempotent
  // backup flows without special-casing "no blocks yet" as an error.
  // Previously returned 404 'No block types match the export filter.'
  // — reported in MCP-FEEDBACK-2.
  if (filtered.length === 0) {
    return apiResponse(ctx, {
      manifest: { name: pkgName, version: pkgVersion, blocks: [] },
      zip_base64: null,
      size_bytes: 0,
      block_count: 0,
      note: wantedIds
        ? `None of the requested ids (${wantedIds.join(', ')}) match an existing block type.`
        : 'This site has no user-created block types yet. Nothing to export.',
    });
  }

  const buf = await packBlockTypes({
    manifest: { name: pkgName, version: pkgVersion },
    block_types: filtered,
  });

  return apiResponse(ctx, {
    manifest: { name: pkgName, version: pkgVersion, blocks: filtered.map((b) => b.name) },
    zip_base64: buf.toString('base64'),
    size_bytes: buf.byteLength,
    block_count: filtered.length,
  });
};
