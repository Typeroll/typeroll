// GET/PUT/DELETE /api/sites/{siteId}/form-spam-protection
//
// Cookie-auth counterpart of /api/v1/sites/{siteId}/integrations/form-spam-protection,
// for the portal's Forms page. Admin only. The secret is encrypted and only
// ever returned as { set: true }.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../lib/access';
import { FormSpamProtectionError, readFormSpamProtection, removeFormSpamProtection, saveFormSpamProtection } from '../../../../lib/forms/turnstile';

async function admin(cookies: Parameters<APIRoute>[0]['cookies'], siteId: string | undefined, locals: Parameters<APIRoute>[0]['locals']) {
  const guard = await requireSiteAccess(cookies, siteId, locals);
  if (!guard.ok) return guard;
  const check = requirePermission(guard.value, 'admin');
  if (!check.ok) return check;
  return { ok: true as const, orgId: guard.value.owner_org_id, siteId: guard.value.site.id };
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const access = await admin(cookies, params.siteId, locals);
  if (!access.ok) return access.response;
  return json(await readFormSpamProtection(access.orgId, access.siteId));
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const access = await admin(cookies, params.siteId, locals);
  if (!access.ok) return access.response;
  try {
    return json(await saveFormSpamProtection(access.orgId, access.siteId, await request.json().catch(() => null)));
  } catch (error) {
    if (error instanceof FormSpamProtectionError) return json({ error: error.message }, error.status);
    throw error;
  }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const access = await admin(cookies, params.siteId, locals);
  if (!access.ok) return access.response;
  return json(await removeFormSpamProtection(access.orgId, access.siteId));
};
