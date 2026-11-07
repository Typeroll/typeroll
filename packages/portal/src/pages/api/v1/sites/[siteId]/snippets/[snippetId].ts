// GET    /api/v1/sites/{siteId}/snippets/{snippetId}
// PUT    /api/v1/sites/{siteId}/snippets/{snippetId}   — create or replace the whole snippet
//   body: { name, kind, format?, content?, entries?, fallback?, expected_updated_at? }
// DELETE /api/v1/sites/{siteId}/snippets/{snippetId}   — also removes its live file
//   ?expected_updated_at=… refuses a stale delete with 409
//
// PUT is revision checked: send the `updated_at` you read as
// `expected_updated_at` ('' to create one that must not exist yet) and a save
// made in between is refused with 409. Without it a missing snippet is
// created (201) and an existing one replaced. The response's `live` says
// whether the public file was written; the snippet is saved either way.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, type ApiContext } from '../../../../../../lib/api-auth';
import { pathParam } from '../../../../../../lib/path-param';
import { apiUpdatedBy, deleteSnippet, readSnippet, saveSnippet, SnippetSaveError, snippetLiveInfo } from '../../../../../../lib/snippet-write';

function snippetFailure(error: unknown, ctx: ApiContext): Response {
  if (error instanceof SnippetSaveError) return apiError(error.message, error.status, ctx, error.errors ? { details: { errors: error.errors } } : undefined);
  throw error;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const id = pathParam(params.snippetId);
  if (!id) return apiError('Missing snippetId', 400, ctx);
  const snippet = await readSnippet(ctx, id);
  if (!snippet) return apiError('Snippet not found', 404, ctx);
  const live = await snippetLiveInfo(ctx);
  return apiResponse(ctx, { snippet, live_url: live.base_url ? `${live.base_url}/${snippet.id}.json` : null, ...(live.reason ? { live_reason: live.reason } : {}) });
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const id = pathParam(params.snippetId);
  if (!id) return apiError('Missing snippetId', 400, ctx);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);
  const { expected_updated_at: expected, ...snippet } = body;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') return apiError('expected_updated_at must be the updated_at string you read', 400, ctx);
  try {
    const saved = await saveSnippet(ctx, snippet, {
      mode: 'replace', id, permission: ctx.permission, updatedBy: apiUpdatedBy(ctx.keyPrefix),
      ...(typeof expected === 'string' ? { expectedUpdatedAt: expected } : expected === null ? { expectedUpdatedAt: '' } : {}),
    });
    return apiResponse(ctx, { snippet: saved.snippet, live: saved.live }, saved.created ? 201 : 200, body);
  } catch (error) { return snippetFailure(error, ctx); }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const id = pathParam(params.snippetId);
  if (!id) return apiError('Missing snippetId', 400, ctx);
  const expected = new URL(request.url).searchParams.get('expected_updated_at');
  try {
    const result = await deleteSnippet(ctx, id, { permission: ctx.permission, ...(expected !== null ? { expectedUpdatedAt: expected } : {}) });
    return apiResponse(ctx, { ok: true, live: result.live });
  } catch (error) { return snippetFailure(error, ctx); }
};
