// GET    /api/v1/sites/{siteId}/block-types/{typeId}  → fetch a type
// PATCH  /api/v1/sites/{siteId}/block-types/{typeId}  → update a site type
// DELETE /api/v1/sites/{siteId}/block-types/{typeId}  → remove a site type
//
// GET resolves core blocks (shipped in code) and the site's own types
// uniformly. PATCH and DELETE only operate on site types — a core block
// answers 403 — and need admin permission on the site.
//
// PATCH is validated by the shared validator against the stored type. It
// also takes `renames: { "old.path": "new_name" }` and `confirm_data_loss`:
// renamed fields move their data in every block that uses the type (pages
// and drafts, templates, headers, footers, global blocks, block templates,
// other block types), removing or retyping a field that holds data answers
// 409 with the affected uses unless confirmed. 200 → `{ block_type,
// warnings, impact? }`. DELETE answers 409 while the type is in use.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { CORE_BLOCK_TYPES } from '@typeroll/shared';
import { pathParam } from '../../../../../../lib/path-param';
import {
  BLOCK_TYPE_ADMIN_REQUIRED,
  blockTypeView,
  deleteSiteBlockType,
  updateSiteBlockType,
} from '../../../../../../lib/block-type-write';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = pathParam(params.typeId);
  if (!typeId) return apiError('Missing typeId');

  // Core block types ship in code, not the datastore — look there first.
  const fromCore = CORE_BLOCK_TYPES.find((b) => b.id === typeId);
  if (fromCore) return apiResponse(ctx, { block_type: fromCore });

  const doc = await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  if (!doc) return apiError('Not found', 404, ctx);
  return apiResponse(ctx, { block_type: blockTypeView({ ...doc, id: typeId }) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = pathParam(params.typeId);
  if (!typeId) return apiError('Missing typeId');
  if (CORE_BLOCK_TYPES.some((b) => b.id === typeId)) {
    return apiError('Core block types are managed in code, not editable via API', 403, ctx);
  }
  if (ctx.permission !== 'admin') return apiError(BLOCK_TYPE_ADMIN_REQUIRED, 403, ctx);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON', 400, ctx);

  // `script` through an API key is accepted under the key holder's authority
  // (same trust level as scripts_head and as a person in the portal). The
  // write is audit-logged by apiResponse. See lib/block-script-gate.ts.
  const outcome = await updateSiteBlockType(ctx, typeId, body, {
    allowScript: true,
    actor: ctx.extensionIdentity ? 'app' : 'api',
    actorId: ctx.keyPrefix,
  });
  if (!outcome.ok) return apiResponse(ctx, outcome.body, outcome.status, body);
  return apiResponse(ctx, { ...outcome.body, block_type: blockTypeView(outcome.body.block_type) }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = pathParam(params.typeId);
  if (!typeId) return apiError('Missing typeId');
  if (CORE_BLOCK_TYPES.some((b) => b.id === typeId)) {
    return apiError('Core block types are managed in code, not removable via API', 403, ctx);
  }
  if (ctx.permission !== 'admin') return apiError(BLOCK_TYPE_ADMIN_REQUIRED, 403, ctx);
  const outcome = await deleteSiteBlockType(ctx, typeId);
  return apiResponse(ctx, outcome.body, outcome.status);
};
