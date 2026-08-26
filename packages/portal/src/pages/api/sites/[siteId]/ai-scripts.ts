// Toggle Site.ai_scripts_enabled — the per-site human opt-in that lets
// agent surfaces (MCP tools, chat AI, API-key writes) author the `script`
// field on custom BlockTypes. See lib/block-script-gate.ts for the threat
// model. Deliberately a cookie-auth, admin-only, form-POST route: the flag
// must never be settable through any agent surface, or the gate would be
// self-defeating.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;

  const form = await request.formData();
  const enabled = form.get('ai_scripts_enabled') === 'on';

  // Round-trip the site doc with the flag updated. The store strips `id`
  // itself, so spreading the fetched doc is the supported pattern.
  await getStore().setDoc(paths.site(owner_org_id, site.id), {
    ...site,
    ai_scripts_enabled: enabled,
  });

  return redirect(`/app/sites/${site.id}/settings`);
};
