// POST /api/v1/sites/{siteId}/blocks/import — public API equivalent.
//
// Accepts JSON `{ zip_base64, on_conflict? }` or an `application/zip` body
// (`?on_conflict=` then). Each block type in the package is checked by the
// shared validator; on a name conflict `on_conflict` decides: `skip`
// (default) keeps the site's type, `rename` imports under a free name,
// `replace` overwrites it. Answers per-type `results` with counts. Importing
// block types needs admin permission on the site. Bearer token required.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { unpackBlockPackage, BlockPackageError } from '../../../../../../lib/block-packages';
import { BLOCK_TYPE_ADMIN_REQUIRED, importBlockTypePackage, parseConflictMode } from '../../../../../../lib/block-type-write';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError(BLOCK_TYPE_ADMIN_REQUIRED, 403, ctx);

  const ct = request.headers.get('content-type') ?? '';
  let buf: Buffer;
  let conflictInput: unknown = new URL(request.url).searchParams.get('on_conflict') ?? undefined;
  if (ct.startsWith('application/json')) {
    const body = await request.json().catch(() => null) as { zip_base64?: string; on_conflict?: unknown } | null;
    if (!body?.zip_base64) return apiError('JSON body must include zip_base64.', 400, ctx);
    buf = Buffer.from(body.zip_base64, 'base64');
    conflictInput = body.on_conflict ?? conflictInput;
  } else if (ct.startsWith('application/zip') || ct.startsWith('application/octet-stream')) {
    buf = Buffer.from(await request.arrayBuffer());
  } else {
    return apiError(`Unsupported content-type "${ct}".`, 415, ctx);
  }
  const onConflict = parseConflictMode(conflictInput);
  if (!onConflict) return apiError('on_conflict must be skip, rename or replace.', 400, ctx);

  let result;
  try {
    result = await unpackBlockPackage(buf);
  } catch (e) {
    if (e instanceof BlockPackageError) {
      const status = e.code === 'too_large' ? 413 : 400;
      return apiError(e.message, status, ctx);
    }
    throw e;
  }

  // `script` in a package is accepted under the key holder's authority, as
  // on create (see lib/block-script-gate.ts); the import is audit-logged.
  const outcome = await importBlockTypePackage(ctx, result.blocks, { onConflict, allowScript: true });
  return apiResponse(ctx, { manifest: result.manifest, on_conflict: onConflict, ...outcome, warnings: result.warnings }, 200, { on_conflict: onConflict, manifest: result.manifest });
};
