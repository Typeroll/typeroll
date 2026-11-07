// GET /api/sites/{siteId}/packages/exportable   — what the export form can offer
//     → { block_templates: [{ id, name, kind, category }], page_templates: [{ id, label, applies_to }],
//         global_blocks: [{ id, name }] (free block global blocks), block_types: [{ id, label }],
//         styles: [{ id, name, role }], menus: [{ id, name }],
//         font_families: [{ family, source: "upload" | "catalog" | "service" }],
//         media: [{ id, filename, url, demo }] }

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../lib/access';
import { exportableSiteContent } from '../../../../../lib/packages/package-export';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id, versionId } = guard.value;
  return json(await exportableSiteContent({ orgId: owner_org_id, siteId: site.id, versionId }));
};
