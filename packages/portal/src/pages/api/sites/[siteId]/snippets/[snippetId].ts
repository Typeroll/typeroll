// GET    /api/sites/{siteId}/snippets/{snippetId}
// PUT    /api/sites/{siteId}/snippets/{snippetId}   — replace the whole snippet
//        JSON: { name, kind, format?, content?, entries?, fallback?, expected_updated_at? }
// DELETE /api/sites/{siteId}/snippets/{snippetId}   — also removes its live file
//
// The portal's session routes; they share the v1 save path.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { pathParam } from '../../../../../lib/path-param';
import { deleteSnippet, readSnippet, saveSnippet, snippetFailureBody, snippetLiveInfo } from '../../../../../lib/snippet-write';

function snippetFailure(error: unknown): Response {
  const refused = snippetFailureBody(error);
  if (!refused) throw error;
  return json(refused.body, refused.status);
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const id = pathParam(params.snippetId);
  if (!id) return json({ error: 'Missing snippetId' }, 400);
  const ctx = { orgId: owner_org_id, siteId: site.id };
  const snippet = await readSnippet(ctx, id);
  if (!snippet) return json({ error: 'Snippet not found' }, 404);
  const live = await snippetLiveInfo(ctx);
  return json({ snippet, live_url: live.base_url ? `${live.base_url}/${snippet.id}.json` : null, ...(live.reason ? { live_reason: live.reason } : {}) });
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id, permission } = guard.value;
  const id = pathParam(params.snippetId);
  if (!id) return json({ error: 'Missing snippetId' }, 400);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON body' }, 400);
  const { expected_updated_at: expected, ...snippet } = body;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') return json({ error: 'expected_updated_at must be a string' }, 400);
  try {
    const saved = await saveSnippet({ orgId: owner_org_id, siteId: site.id }, snippet, {
      mode: 'replace', id, permission, updatedBy: session.email ?? 'unknown',
      ...(typeof expected === 'string' ? { expectedUpdatedAt: expected } : expected === null ? { expectedUpdatedAt: '' } : {}),
    });
    return json({ snippet: saved.snippet, live: saved.live }, saved.created ? 201 : 200);
  } catch (error) { return snippetFailure(error); }
};

export const DELETE: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id, permission } = guard.value;
  const id = pathParam(params.snippetId);
  if (!id) return json({ error: 'Missing snippetId' }, 400);
  const expected = new URL(request.url).searchParams.get('expected_updated_at');
  try {
    const result = await deleteSnippet({ orgId: owner_org_id, siteId: site.id }, id, { permission, ...(expected !== null ? { expectedUpdatedAt: expected } : {}) });
    return json({ ok: true, live: result.live });
  } catch (error) { return snippetFailure(error); }
};
