// POST /api/v1/sites/{siteId}/blocks/import — public API equivalent.
//
// Accepts JSON `{ zip_base64 }` or `application/zip` body. Returns the
// same shape as the cookie-authenticated route. Bearer token required.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import { unpackBlockPackage, BlockPackageError } from '../../../../../../lib/block-packages';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const ct = request.headers.get('content-type') ?? '';
  let buf: Buffer;
  if (ct.startsWith('application/json')) {
    const body = await request.json().catch(() => null) as { zip_base64?: string } | null;
    if (!body?.zip_base64) return apiError('JSON body must include zip_base64.');
    buf = Buffer.from(body.zip_base64, 'base64');
  } else if (ct.startsWith('application/zip') || ct.startsWith('application/octet-stream')) {
    buf = Buffer.from(await request.arrayBuffer());
  } else {
    return apiError(`Unsupported content-type "${ct}".`, 415);
  }

  let result;
  try {
    result = await unpackBlockPackage(buf);
  } catch (e) {
    if (e instanceof BlockPackageError) {
      const status = e.code === 'too_large' ? 413 : 400;
      return apiError(e.message, status);
    }
    throw e;
  }

  const store = getStore();
  const basePath = paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId);
  let created = 0, updated = 0;
  const writtenIds: string[] = [];
  for (const { id, block_type } of result.blocks) {
    const existing = await store.getDoc(`${basePath}/${id}`);
    if (existing) updated++; else created++;
    await store.setDoc(`${basePath}/${id}`, block_type);
    writtenIds.push(id);
  }

  return apiResponse(ctx, {
    manifest: result.manifest,
    created,
    updated,
    block_type_ids: writtenIds,
    warnings: result.warnings,
  });
};
