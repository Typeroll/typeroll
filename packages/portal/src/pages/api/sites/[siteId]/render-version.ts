// POST /api/sites/{siteId}/render-version  body: { render_version }
//
// Upgrades (or rolls back) the platform render version for the active site
// version. Design work: administrators and builders. The change takes effect in preview immediately and on
// the live site at the next deploy.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requireDesign } from '../../../../lib/access';
import { vstore } from '../../../../lib/version-store';
import { isRenderVersion, LATEST_RENDER_VERSION, renderVersionStatus } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const designCheck = requireDesign(guard.value);
  if (!designCheck.ok) return designCheck.response;
  const { site, versionId, owner_org_id } = guard.value;
  const body = (await request.json().catch(() => null)) as { render_version?: unknown } | null;
  if (!body || !isRenderVersion(body.render_version)) {
    return json({ error: `render_version must be an integer from 1 to ${LATEST_RENDER_VERSION}` }, 400);
  }
  await vstore.writeSettings(owner_org_id, site.id, versionId, { render_version: body.render_version });
  return json({ ok: true, render: renderVersionStatus(body.render_version) });
};
