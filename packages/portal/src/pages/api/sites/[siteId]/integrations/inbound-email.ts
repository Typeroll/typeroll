// Cookie-auth, admin-only: incoming email forwarding (Settings → Email & notifications).
// Shares lib/email/site-email-settings with the v1 API
// (/api/v1/sites/{siteId}/delivery/inbound) and the MCP incoming email tools.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import {
  EmailSettingsError,
  readIncomingEmailSettings,
  saveIncomingEmailSetting,
} from '../../../../../lib/email/site-email-settings';

const handle: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const { owner_org_id, site } = guard.value;
  try {
    if (request.method === 'PUT') {
      return json(await saveIncomingEmailSetting(owner_org_id, site.id, await request.json().catch(() => null)));
    }
    return json(await readIncomingEmailSettings(owner_org_id, site.id));
  } catch (error) {
    if (error instanceof EmailSettingsError) return json({ error: error.message }, error.status);
    throw error;
  }
};
export const GET = handle;
export const PUT = handle;
