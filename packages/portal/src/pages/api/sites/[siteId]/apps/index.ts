// Cookie-auth, admin-only: list every Typeroll app with this site's
// enabled/config state (masked). Powers the Apps settings page and the
// sidebar's conditional Insights link. NOT on the AI/MCP surface.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { listAppDefs } from '../../../../../lib/apps/registry';
import { maskAppState } from '../../../../../lib/apps/config';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;

  const doc = await getStore().getDoc<SiteApps>(paths.apps(owner_org_id, site.id));
  return json({
    apps: listAppDefs().map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      affects_build: Boolean(def.affects_build),
      fields: def.fields,
      state: maskAppState(def.id, doc?.apps?.[def.id]),
    })),
  });
};
