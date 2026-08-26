import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';

/** Delete a branch. Main can never be deleted. */
export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { versionId } = params;
  if (!versionId) return json({ error: 'Missing versionId' }, 400);
  if (versionId === MAIN_VERSION_ID) {
    return json({ error: 'The main version cannot be deleted.' }, 400);
  }

  const store = getStore();
  const docPath = paths.version(owner_org_id, site.id, versionId);
  const existing = await store.getDoc(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);

  // Wipe the whole version subtree — overrides, tombstones, revisions, chat
  // history — so nothing survives as an orphan. If a new branch is later
  // created with a name that slugs to the same id, it starts clean.
  await store.deleteTree(docPath);
  return json({ ok: true });
};
