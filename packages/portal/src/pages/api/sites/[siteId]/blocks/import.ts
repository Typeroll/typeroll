// POST /api/sites/{siteId}/blocks/import
//
// Accept a .tcblocks zip (multipart field "package", JSON `{ zip_base64 }`,
// or a raw zip body); validate, unpack, and write each block type through
// lib/block-type-write.ts.
//
// Each definition is checked with the shared block type validator. On a name
// conflict `on_conflict` (query, multipart field or JSON body) decides:
// `skip` (default) keeps the site's type, `rename` imports under a free name,
// `replace` overwrites it. The response reports what happened per type
// (`results`) with counts. Importing block types needs admin permission on
// the site.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { unpackBlockPackage, BlockPackageError } from '../../../../../lib/block-packages';
import { importBlockTypePackage, parseConflictMode } from '../../../../../lib/block-type-write';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, versionId, owner_org_id } = guard.value;

  let buf: Buffer;
  let conflictInput: unknown = new URL(request.url).searchParams.get('on_conflict') ?? undefined;
  const ct = request.headers.get('content-type') ?? '';

  if (ct.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('package');
    if (!(file instanceof File)) {
      return json({ error: 'Multipart field "package" must contain the .tcblocks file.' }, 400);
    }
    buf = Buffer.from(await file.arrayBuffer());
    conflictInput = form.get('on_conflict') ?? conflictInput;
  } else if (ct.startsWith('application/json')) {
    // MCP and the public API push base64 because spawning a multipart request
    // from those clients is cumbersome.
    const body = await request.json().catch(() => null) as { zip_base64?: string; on_conflict?: unknown } | null;
    if (!body?.zip_base64) {
      return json({ error: 'JSON body must include zip_base64.' }, 400);
    }
    buf = Buffer.from(body.zip_base64, 'base64');
    conflictInput = body.on_conflict ?? conflictInput;
  } else if (ct.startsWith('application/zip') || ct.startsWith('application/octet-stream')) {
    buf = Buffer.from(await request.arrayBuffer());
  } else {
    return json({ error: `Unsupported content-type "${ct}".` }, 415);
  }
  const onConflict = parseConflictMode(conflictInput);
  if (!onConflict) return json({ error: 'on_conflict must be skip, rename or replace.' }, 400);

  let result;
  try {
    result = await unpackBlockPackage(buf);
  } catch (e) {
    if (e instanceof BlockPackageError) {
      const status = e.code === 'too_large' ? 413 : 400;
      return json({ error: e.message, code: e.code }, status);
    }
    throw e;
  }

  // A human admin in the portal is the trusted author of block scripts.
  const outcome = await importBlockTypePackage(
    { orgId: owner_org_id, siteId: site.id, versionId },
    result.blocks,
    { onConflict, allowScript: true },
  );
  return json({ manifest: result.manifest, on_conflict: onConflict, ...outcome, warnings: result.warnings });
};
