// Toggle Site.ai_scripts_enabled ("Allow AI to write block scripts") from the
// portal Settings form. The flag lets the in-portal chat assistant author
// block JavaScript; API keys and MCP are not gated by it (see
// lib/block-script-gate.ts). Site admins can set the same flag through
// PATCH /api/v1/sites/{siteId} (MCP `update_site`), with the same admin
// permission check as this route.

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
