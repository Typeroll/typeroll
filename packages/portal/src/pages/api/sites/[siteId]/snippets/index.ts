// GET  /api/sites/{siteId}/snippets   — the site's live snippets and where
//      their live files are served, for the portal's snippet editor
// POST /api/sites/{siteId}/snippets   — create a snippet (JSON: { id?, name, kind, format?, content?, entries?, fallback? })
//
// The portal's session routes share the v1 save path (lib/snippet-write.ts):
// validation and sanitizing, the revision check and the live file.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { listSnippets, saveSnippet, snippetFailureBody, snippetLiveInfo } from '../../../../../lib/snippet-write';

function snippetFailure(error: unknown): Response {
  const refused = snippetFailureBody(error);
  if (!refused) throw error;
  return json(refused.body, refused.status);
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id, permission } = guard.value;
  const ctx = { orgId: owner_org_id, siteId: site.id };
  const [snippets, live] = await Promise.all([listSnippets(ctx), snippetLiveInfo(ctx)]);
  return json({ snippets, live, can_edit: permission !== 'read' });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id, permission } = guard.value;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON body' }, 400);
  try {
    const saved = await saveSnippet({ orgId: owner_org_id, siteId: site.id }, body, { mode: 'create', permission, updatedBy: session.email ?? 'unknown' });
    return json({ snippet: saved.snippet, live: saved.live }, 201);
  } catch (error) { return snippetFailure(error); }
};
