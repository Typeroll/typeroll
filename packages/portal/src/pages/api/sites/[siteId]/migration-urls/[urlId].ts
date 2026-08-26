// PUT: update an inventory entry (mark excluded, add notes).
// DELETE: remove an entry from the inventory.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { MigrationUrl } from '@typeroll/shared';

const ALLOWED: Array<keyof MigrationUrl> = ['excluded', 'notes', 'gsc_clicks', 'gsc_impressions'];

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { urlId } = params;
  if (!urlId) return json({ error: 'Missing urlId' }, 400);

  const body = (await request.json().catch(() => ({}))) as Partial<MigrationUrl>;
  const update: Record<string, unknown> = {};
  for (const key of ALLOWED) {
    if (key in body) update[key] = body[key];
  }
  if (!Object.keys(update).length) return json({ error: 'No allowed fields to update' }, 400);

  const docPath = paths.migrationUrl(owner_org_id, site.id, urlId);
  const existing = await getStore().getDoc(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);
  await getStore().updateDoc(docPath, update);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { urlId } = params;
  if (!urlId) return json({ error: 'Missing urlId' }, 400);

  await getStore().deleteDoc(paths.migrationUrl(owner_org_id, site.id, urlId));
  return json({ ok: true });
};
