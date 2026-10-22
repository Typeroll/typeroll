// Cookie-auth, admin-only: read + write one Typeroll app's per-site state
// (enabled + config). Mirrors integrations/email.ts — schema-driven
// encryption/masking, secrets never returned in plaintext. Writes go through
// lib/apps/manage.ts → saveAppState, shared with the admin-only public API
// route /api/v1/sites/{siteId}/apps/{appId} (MCP `read_app` / `update_app`).
// The in-portal chat assistant has no app tools.
//
// On enabling the analytics app, saveAppState creates (or verifies) the
// Cloudflare Web Analytics site in the account that hosts the site. When it
// cannot, the response carries the cause and the next step (409 when no
// beacon could be set up); see lib/apps/provision-analytics.ts.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { getAppDef } from '../../../../../lib/apps/registry';
import { maskAppState } from '../../../../../lib/apps/config';
import { AppManagementError, incompleteSetupError, saveAppState } from '../../../../../lib/apps/manage';

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
    const state = maskAppState(def.id, result.state);
    const incomplete = incompleteSetupError(appId, result.state, result.setup);
    if (incomplete) {
      return json({ error: incomplete.message, code: incomplete.code, details: incomplete.details, saved: true, state, affects_build: result.affectsBuild }, incomplete.status);
    }
    return json({
      state,
      setup: result.setup,
      affects_build: result.affectsBuild,
    });
  } catch (error) {
    if (error instanceof AppManagementError) {
      return json({ error: error.message, ...(error.code ? { code: error.code, details: error.details, saved: false } : {}) }, error.status);
    }
    return json({ error: 'Failed to save app config' }, 500);
  }
};
