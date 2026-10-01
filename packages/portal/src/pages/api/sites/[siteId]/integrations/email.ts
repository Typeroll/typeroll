// Cookie-auth, admin-only: the per-site email connector (Settings → Email & notifications).
//
// Provider-agnostic: the connector's provider-specific settings live in
// `config`, and encryption / masking / validation are driven by the provider's
// declared field schema (lib/email/providers). Adding a provider needs no
// change here. Secrets are encrypted at rest with INTEGRATIONS_SECRET_KEY and
// never returned in plaintext — GET masks them.
//
// The logic lives in lib/email/site-email-settings, shared with the v1 API
// (/api/v1/sites/{siteId}/integrations/email) and the MCP email tools, which
// require the same admin permission.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import {
  EmailSettingsError,
  readEmailSettings,
  removeEmailSettings,
  saveEmailSettings,
  sendTestEmail,
} from '../../../../../lib/email/site-email-settings';

function failure(error: unknown): Response {
  if (error instanceof EmailSettingsError) return json({ error: error.message }, error.status);
  throw error;
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  return json(await readEmailSettings(owner_org_id, site.id));
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  try {
    return json(await saveEmailSettings(owner_org_id, site.id, await request.json().catch(() => null)));
  } catch (error) {
    return failure(error);
  }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  return json(await removeEmailSettings(owner_org_id, site.id));
};

// POST → send a test email to `to` using the stored connector.
export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  try {
    return json(await sendTestEmail(owner_org_id, site, await request.json().catch(() => null)));
  } catch (error) {
    return failure(error);
  }
};
