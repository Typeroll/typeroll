// POST /api/sites/{siteId}/pages/{pageId}/blocks/reusable
//   { action: 'make_global' | 'detach' | 'insert_template', ... }
// Session route for the block editor; the v1 routes make-global, detach and
// insert-template take the same fields.

import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../../../lib/access';
import { runReusableAction, type ReusableAction } from '../../../../../../../lib/reusable-block-actions';
import { structureLockRefusal } from '../../../../../../../lib/structure-lock';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const check = requirePermission(guard.value, 'write');
  if (!check.ok) return check.response;
  if (!params.pageId) return json({ error: 'Missing pageId' }, 400);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action;
  if (!body || !['make_global', 'detach', 'insert_template'].includes(String(action))) return json({ error: 'action must be make_global, detach or insert_template' }, 400);
  const { site, versionId, owner_org_id, design } = guard.value;
  // Making a block global, detaching one and inserting a template all change the page's structure.
  const ctx = { orgId: owner_org_id, siteId: site.id, versionId, canDesign: design };
  const locked = await structureLockRefusal(ctx);
  if (locked) return locked;
  const result = await runReusableAction(ctx, params.pageId, action as ReusableAction, body);
  return json(result.body, result.status);
};
