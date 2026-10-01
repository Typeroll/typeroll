// GET /api/sites/{siteId}/form-capabilities
//
// What the form editor may offer: every registered action type and prefill
// source, with the config schema each declares. Without this the editor can
// only ever render the types it was hand-coded for — which is exactly how it
// ended up email-only while apps were contributing others nobody could pick.
//
// Reads the registries (lib/form-capabilities, shared with the v1 API and
// MCP), so an app that adds an action or a source appears here with no change
// to this route or to the editor.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../lib/access';
import { formCapabilities } from '../../../../lib/form-capabilities';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  // Admin-only: actions are admin-only to configure, and an editor who can't
  // configure them has no use for seeing them.
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  return json(await formCapabilities());
};
