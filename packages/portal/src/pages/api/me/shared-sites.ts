// List every site shared *into* the calling user's org. Used by the
// dashboard's "Shared with me" section. One read against the flat
// share index + one site read per active share — small enough at
// agency-scale grants per recipient that no pagination is needed in v1.

import type { APIRoute } from 'astro';
import { requireFullSession, json } from '../../../lib/access';
import { hydrateSharedSites } from '../../../lib/shares';

export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const entries = await hydrateSharedSites(session.orgId);
  return json({
    shared_sites: entries.map(({ share, site }) => ({
      site: {
        id: site.id,
        name: site.name,
        slug: site.slug,
        domain: site.domain,
      },
      owner_org_id: share.owner_org_id,
      permission: share.permission,
      shared_at: share.created_at,
      label: share.label,
    })),
  });
};
