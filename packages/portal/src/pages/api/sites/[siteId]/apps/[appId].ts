// Cookie-auth, admin-only: read + write one Typeroll app's per-site state
// (enabled + config). Mirrors integrations/email.ts — schema-driven
// encryption/masking, secrets never returned in plaintext. This is the
// ONLY writer of app state and is NOT exposed on any AI/MCP surface.
//
// On enabling the analytics app we best-effort auto-provision a Cloudflare
// Web Analytics site (when CF creds + a site domain exist) so the owner
// doesn't have to paste a token by hand; failures are non-fatal (they can
// paste one).

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { getAppDef } from '../../../../../lib/apps/registry';
import { maskAppState } from '../../../../../lib/apps/config';
import { AppManagementError, saveAppState } from '../../../../../lib/apps/manage';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const def = getAppDef(String(params.appId));
  if (!def) return json({ error: 'Unknown app' }, 404);

  const doc = await getStore().getDoc<SiteApps>(paths.apps(owner_org_id, site.id));
  return json({
    id: def.id,
    name: def.name,
    description: def.description,
    fields: def.fields,
    affects_build: Boolean(def.affects_build),
    state: maskAppState(def.id, doc?.apps?.[def.id]),
  });
};

interface PutBody {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const appId = String(params.appId);
  const def = getAppDef(appId);
  if (!def) return json({ error: 'Unknown app' }, 404);

  const body = (await request.json().catch(() => null)) as PutBody | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  const enabled = Boolean(body.enabled);
  try {
    const result = await saveAppState({
      orgId: owner_org_id,
      siteId: site.id,
      appId,
      enabled,
      config: body.config,
    });
    return json({
      state: maskAppState(def.id, result.state),
      affects_build: result.affectsBuild,
    });
  } catch (error) {
    if (error instanceof AppManagementError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to save app config' }, 500);
  }
};
