// POST /api/sites/{siteId}/domain/poll
//
// Ask Cloudflare for the current state of the custom domain and update
// the Site doc. Returns the fresh DomainStateResponse. Used by the
// settings UI's "Check status" button. Idempotent — safe to call once
// a minute.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { pollDomainStatus, DomainServiceError } from '../../../../../lib/site-domain';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  try {
    const state = await pollDomainStatus(owner_org_id, site.id);
    return json({ domain: state });
  } catch (e) {
    if (e instanceof DomainServiceError) return json({ error: e.message }, e.status);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};
