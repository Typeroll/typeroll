// Working-copy operations for agents (Bearer-authed v1 surface):
//   GET    /v1/sites/{id}/working-copy/{target} → read (null when none)
//   PUT    → shallow-merge fields (edit without saving)
//   POST   → COMMIT: promote through the canonical write path + delete
//   DELETE → discard
//
// Target address: `page/{id}`, `partial/{id}`, `item/{collection}/{itemId}`.
// Same lib (and therefore exactly the same whitelists + commit invariants)
// as the cookie-auth editor route — a human Save and an agent commit are
// the same operation.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import {
  commitWorkingCopy,
  discardWorkingCopy,
  filterWcFields,
  mergeWorkingCopy,
  parseWcTarget,
  readWorkingCopy,
  WorkingCopyError,
  type WcCtx,
  type WcTarget,
} from '../../../../../../lib/working-copy';

async function targetExists(ctx: WcCtx, target: WcTarget): Promise<boolean> {
  if (target.kind === 'page') {
    return !!(await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.id));
  }
  if (target.kind === 'partial') return true; // create-on-write, like the canonical PUT
  return !!(await vstore.collectionItem(
    ctx.orgId, ctx.siteId, ctx.versionId, target.collection, target.id,
  ));
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return apiError('Bad working-copy target — use page/{id}, partial/{id} or item/{collection}/{itemId}', 400);
  const wc = await readWorkingCopy(ctx, target);
  return apiResponse(ctx, { working_copy: wc });
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return apiError('Bad working-copy target — use page/{id}, partial/{id} or item/{collection}/{itemId}', 400);

  const body = (await request.json().catch(() => null)) as
    | { fields?: Record<string, unknown> }
    | null;
  if (!body?.fields || typeof body.fields !== 'object') {
    return apiError('fields object required', 400);
  }
  if (!(await targetExists(ctx, target))) return apiError('Target not found', 404);

  try {
    const filtered = await filterWcFields(ctx, target, body.fields);
    const wc = await mergeWorkingCopy(ctx, target, filtered, `api-key:${ctx.keyPrefix}`);
    return apiResponse(ctx, { ok: true, updated_at: wc.updated_at }, 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return apiError('Bad working-copy target — use page/{id}, partial/{id} or item/{collection}/{itemId}', 400);
  try {
    const result = await commitWorkingCopy(ctx, target, `api-key:${ctx.keyPrefix}`);
    return apiResponse(ctx, { ok: true, ...result }, 200, {});
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const target = parseWcTarget(params.target);
  if (!target) return apiError('Bad working-copy target — use page/{id}, partial/{id} or item/{collection}/{itemId}', 400);
  await discardWorkingCopy(ctx, target);
  return apiResponse(ctx, { ok: true }, 200, {});
};
