// POST /api/sites/{siteId}/preview-link  body: { path?, render_version? }
//
// Portal (session) counterpart of POST /api/v1/sites/{siteId}/preview-link,
// used to preview a render-version upgrade before saving it. The link is a
// normal signed, expiring preview link for the active site version.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../lib/access';
import { signPreviewTicket, isPreviewSigningConfigured } from '../../../../lib/preview-signing';
import { isRenderVersion, LATEST_RENDER_VERSION } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  if (!isPreviewSigningConfigured()) return json({ error: 'Preview links are not configured on this server' }, 503);
  const { site, versionId, owner_org_id } = guard.value;
  const body = (await request.json().catch(() => ({}))) as { path?: unknown; render_version?: unknown };
  if (body.render_version !== undefined && !isRenderVersion(body.render_version)) {
    return json({ error: `render_version must be an integer from 1 to ${LATEST_RENDER_VERSION}` }, 400);
  }
  const path = typeof body.path === 'string' ? body.path.replace(/^\/+/, '').replace(/[?#].*$/, '') : '';
  const { token, expiresAt } = signPreviewTicket({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    ttlSeconds: 4 * 60 * 60,
    renderVersion: body.render_version as number | undefined,
  });
  return json({ url: `/preview/${site.id}/${path}?t=${encodeURIComponent(token)}`, expires_at: expiresAt });
};
