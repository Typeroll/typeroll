// GET /api/sites/{siteId}/form-capabilities
//
// What the form editor may offer: every registered action type and prefill
// source, with the config schema each declares. Without this the editor can
// only ever render the types it was hand-coded for — which is exactly how it
// ended up email-only while apps were contributing others nobody could pick.
//
// Reads the registries, so an app that adds an action or a source appears
// here with no change to this route or to the editor.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../lib/access';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  // Admin-only: the list includes admin-only types, and an editor who can't
  // configure them has no use for seeing them.
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;

  const { actionRegistry } = await import('../../../../lib/forms/actions');
  const { prefillRegistry } = await import('../../../../lib/forms/prefill');

  return json({
    actions: [...(await actionRegistry()).values()].map((a) => ({
      type: a.type,
      label: a.label,
      description: a.description,
      admin_only: Boolean(a.admin_only),
      config_fields: a.config_fields ?? [],
      // Whether it can also veto a submit, so the editor can say so.
      has_before: typeof a.before === 'function',
    })),
    prefill_sources: [...(await prefillRegistry()).values()].map((s) => ({
      type: s.type,
      label: s.label,
      description: s.description,
      config_fields: s.config_fields ?? [],
    })),
  });
};
