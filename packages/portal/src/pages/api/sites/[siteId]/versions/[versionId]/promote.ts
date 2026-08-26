import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { promoteBranch } from '../../../../../../lib/version-promote';
import { MAIN_VERSION_ID } from '@typeroll/shared';

/**
 * Promote a branch's overrides + tombstones to main. The branch is left in
 * place — its overrides remain, so further work on it continues to diff
 * against the now-updated main. Users typically delete the branch from the
 * picker once they've promoted.
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
    return json({ error: 'Main cannot be promoted onto itself.' }, 400);
  }
  const applied = await promoteBranch(owner_org_id, site.id, versionId, MAIN_VERSION_ID, session.email);
  return json({ ok: true, applied });
};
