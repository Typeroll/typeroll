// Cookie-authenticated CRUD for the per-site BlockType collection.
//   GET    /api/sites/{siteId}/blocks/types          → list
//   POST   /api/sites/{siteId}/blocks/types          → create
//   PATCH  /api/sites/{siteId}/blocks/types?id=…     → update (renames, confirm_data_loss)
//   DELETE /api/sites/{siteId}/blocks/types?id=…     → remove (refused while in use)
//
// Writes go through lib/block-type-write.ts, the one write path every surface
// shares (shared validator, version chain, rename migration). Creating,
// changing and deleting block types needs admin permission on the site;
// editors place block types on pages and edit their fields. A portal admin
// is the trusted author of `script` (see lib/block-script-gate.ts).
//
// Errors answer `{ error, problems }` (400), `409` for an existing name, a
// type in use or unconfirmed data loss. Success answers `{ block_type,
// warnings, impact? }`.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import {
  blockTypeView,
  createSiteBlockType,
  deleteSiteBlockType,
  updateSiteBlockType,
} from '../../../../../lib/block-type-write';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const docs = await vstore.blockTypes(owner_org_id, site.id, versionId);
  return json({ block_types: docs.map(blockTypeView) });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, versionId, owner_org_id } = guard.value;
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const outcome = await createSiteBlockType({ orgId: owner_org_id, siteId: site.id, versionId }, body, { origin: 'user', allowScript: true });
  if (!outcome.ok) return json(outcome.body, outcome.status);
  return json({ ...outcome.body, block_type: blockTypeView(outcome.body.block_type) });
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const outcome = await updateSiteBlockType({ orgId: owner_org_id, siteId: site.id, versionId }, id, body, {
    allowScript: true, actor: 'portal', actorId: session.userId,
  });
  if (!outcome.ok) return json(outcome.body, outcome.status);
  return json({ ...outcome.body, block_type: blockTypeView(outcome.body.block_type) });
};

export const DELETE: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, versionId, owner_org_id } = guard.value;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const outcome = await deleteSiteBlockType({ orgId: owner_org_id, siteId: site.id, versionId }, id);
  return json(outcome.body, outcome.status);
};
