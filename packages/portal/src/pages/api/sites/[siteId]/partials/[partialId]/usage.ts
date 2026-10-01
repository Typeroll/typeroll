// GET /api/sites/{siteId}/partials/{partialId}/usage
//
// What references this global block: pages, page templates and other
// partials (header, footer, nesting global blocks), saved or in a draft.
// Used by the global block editors' usage list. Header/footer are
// special-cased: they're auto-injected on every page, not referenced, so we
// return the full page list and flag it.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { getBlockUsage } from '../../../../../../lib/partials-usage';
import { vstore } from '../../../../../../lib/version-store';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { partialId } = params;
  if (!partialId) return json({ error: 'Missing partialId' }, 400);

  if (partialId === 'header' || partialId === 'footer') {
    const pages = await vstore.pages(owner_org_id, site.id, versionId);
    return json({
      partial_id: partialId,
      auto_injected: true,
      pages: pages.map((p) => ({ page_id: p.id, title: p.title, slug: p.slug, status: p.status })),
      templates: [],
      global_blocks: [],
    });
  }

  const usage = await getBlockUsage(owner_org_id, site.id, versionId, partialId);
  return json({ partial_id: partialId, auto_injected: false, ...usage });
};
