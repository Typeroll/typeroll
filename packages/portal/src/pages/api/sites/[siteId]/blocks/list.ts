// GET /api/sites/{siteId}/blocks/list
//
// Cookie-authenticated list of every BlockType registered for the site.
// Used by the block editor to populate the "Lägg till" tab with user
// and third-party blocks on top of the core library.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths, type BlockType } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const docs = await getStore().listDocs<BlockType>(
    paths.blockTypes(owner_org_id, site.id, versionId),
  );
  return json({ block_types: docs });
};
