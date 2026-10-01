// Retire a site, or bring it back — the portal (session) door.
//
// The rules live in lib/site-lifecycle.ts and are shared with the public API
// route /api/v1/sites/{siteId}/lifecycle (MCP `archive_site` / `restore_site`),
// so this file only reads the session credential and the request body.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requireSiteLifecycleChange, json } from '../../../../lib/access';
import { changeSiteLifecycle } from '../../../../lib/site-lifecycle';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const allowed = requireSiteLifecycleChange(guard.value);
  if (!allowed.ok) return allowed.response;
  const { session, site, owner_org_id } = guard.value;

  // Accepts a form post from the settings page and a JSON body from portal
  // scripts. API keys use the v1 route instead.
  const contentType = request.headers.get('content-type') ?? '';
  const body: Record<string, unknown> = contentType.includes('application/json')
    ? await request.json().catch(() => ({}))
    : Object.fromEntries(await request.formData());

  const outcome = await changeSiteLifecycle({
    ownerOrgId: owner_org_id,
    site,
    action: body.action,
    reason: body.reason,
    actor: session.userId,
  });
  return json(outcome.body, outcome.status);
};
