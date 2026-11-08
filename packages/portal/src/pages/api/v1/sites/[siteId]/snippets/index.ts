// GET  /api/v1/sites/{siteId}/snippets   — every live snippet of the site,
//      with where its live files are served (`live.base_url`, or null and why)
// POST /api/v1/sites/{siteId}/snippets   — create a snippet
//   body: { id?, name, kind: "html" | "text" | "dated", format?, content?, entries?, fallback? }
//
// A live snippet is content outside the publication: it is saved, sanitized
// and written as a public file at once, and the live site shows it within a
// minute without publishing. Snippets belong to the site, not to a version.
// Without an id one is derived from the name; an existing id is refused with
// 409. The response's `live` says whether the live file was written
// (`{ published: true, url }`) or why not (`{ published: false, reason }`);
// the snippet is saved either way. Invalid input answers 400 with
// `details.errors: [{ path, message }]`.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, type ApiContext } from '../../../../../../lib/api-auth';
import { apiUpdatedBy, listSnippets, saveSnippet, SnippetSaveError, snippetLiveInfo } from '../../../../../../lib/snippet-write';

function snippetFailure(error: unknown, ctx: ApiContext): Response {
  if (error instanceof SnippetSaveError) return apiError(error.message, error.status, ctx, error.errors ? { details: { errors: error.errors } } : undefined);
  throw error;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const [snippets, live] = await Promise.all([listSnippets(ctx), snippetLiveInfo(ctx)]);
  return apiResponse(ctx, { snippets, live });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);
  try {
    const saved = await saveSnippet(ctx, body, { mode: 'create', permission: ctx.permission, updatedBy: apiUpdatedBy(ctx.keyPrefix) });
    return apiResponse(ctx, { snippet: saved.snippet, live: saved.live }, 201, body);
  } catch (error) { return snippetFailure(error, ctx); }
};
