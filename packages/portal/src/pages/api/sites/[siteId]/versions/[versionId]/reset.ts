import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { resetBranch } from '../../../../../../lib/version-promote';
import { MAIN_VERSION_ID } from '@typeroll/shared';

/**
 * Wipe every override and tombstone on the branch. Reads through it then
 * pass through straight to main. Revision history on the branch is preserved.
 */
export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { versionId } = params;
  if (!versionId) return json({ error: 'Missing versionId' }, 400);
  if (versionId === MAIN_VERSION_ID) {
    return json({ error: 'Main can\'t be reset — there\'s no base above it.' }, 400);
  }
  const cleared = await resetBranch(owner_org_id, site.id, versionId);
  return json({ ok: true, cleared });
};
