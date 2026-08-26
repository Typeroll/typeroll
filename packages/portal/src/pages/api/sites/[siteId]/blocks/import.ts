// POST /api/sites/{siteId}/blocks/import
//
// Accept a multipart upload of a .tcblocks zip; validate, unpack, and
// persist each block type as a doc under
// organizations/{orgId}/sites/{siteId}/versions/{versionId}/block_types/{id}.
//
// Conflict handling: ids are derived from package_name/block_name. A
// re-import of the same package overwrites existing docs — the
// `imported_from.version` field reflects the new version. The response
// surfaces an `updated` vs `created` count so the caller can show what
// happened.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import { unpackBlockPackage, BlockPackageError } from '../../../../../lib/block-packages';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  let buf: Buffer;
  const ct = request.headers.get('content-type') ?? '';

  if (ct.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('package');
    if (!(file instanceof File)) {
      return json({ error: 'Multipart field "package" must contain the .tcblocks file.' }, 400);
    }
    buf = Buffer.from(await file.arrayBuffer());
  } else if (ct.startsWith('application/json')) {
    // MCP and the public API push base64 because spawning a multipart request
    // from those clients is cumbersome.
    const body = await request.json().catch(() => null) as { zip_base64?: string } | null;
    if (!body?.zip_base64) {
      return json({ error: 'JSON body must include zip_base64.' }, 400);
    }
    buf = Buffer.from(body.zip_base64, 'base64');
  } else if (ct.startsWith('application/zip') || ct.startsWith('application/octet-stream')) {
    buf = Buffer.from(await request.arrayBuffer());
  } else {
    return json({ error: `Unsupported content-type "${ct}".` }, 415);
  }

  let result;
  try {
    result = await unpackBlockPackage(buf);
  } catch (e) {
    if (e instanceof BlockPackageError) {
      const status = e.code === 'too_large' ? 413 : e.code === 'unsafe' ? 400 : 400;
      return json({ error: e.message, code: e.code }, status);
    }
    throw e;
  }

  const store = getStore();
  const basePath = paths.blockTypes(owner_org_id, site.id, versionId);
  let created = 0;
  let updated = 0;
  const writtenIds: string[] = [];
  for (const { id, block_type } of result.blocks) {
    const existing = await store.getDoc(`${basePath}/${id}`);
    if (existing) updated++; else created++;
    await store.setDoc(`${basePath}/${id}`, block_type);
    writtenIds.push(id);
  }

  return json({
    manifest: result.manifest,
    created,
    updated,
    block_type_ids: writtenIds,
    warnings: result.warnings,
  });
};
