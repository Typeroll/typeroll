import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { diffVersion } from '../../../../../../lib/version-promote';
import { MAIN_VERSION_ID } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const { versionId } = params;
  if (!versionId) return json({ error: 'Missing versionId' }, 400);
  if (versionId === MAIN_VERSION_ID) {
    return json({ error: 'Main has nothing to diff against itself.' }, 400);
  }
  const diff = await diffVersion(owner_org_id, site.id, versionId);
  return json(diff);
};
