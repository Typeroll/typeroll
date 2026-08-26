// Bearer-authenticated app configuration. Admin-scoped API keys use the same
// schema validation, secret handling, and provisioning service as the portal.

import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { maskAppState } from '../../../../../../lib/apps/config';
import { AppManagementError, saveAppState } from '../../../../../../lib/apps/manage';
import { getAppDef } from '../../../../../../lib/apps/registry';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403);
  const appId = String(params.appId ?? '');
  const def = getAppDef(appId);
  if (!def) return apiError('Unknown app', 404);
  const doc = await getStore().getDoc<SiteApps>(paths.apps(ctx.orgId, ctx.siteId));
  const state = maskAppState(def.id, doc?.apps?.[def.id]);
  return apiResponse(ctx, {
    // Keep the original funnel-attribution response fields for backwards
    // compatibility while adding the generic descriptor.
    app_id: def.id,
    state,
    app: {
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      affects_build: Boolean(def.affects_build),
      fields: def.fields,
      state,
    },
  });
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403);
  const appId = String(params.appId ?? '');
  const def = getAppDef(appId);
  if (!def) return apiError('Unknown app', 404);
  const body = (await request.json().catch(() => null)) as {
    enabled?: boolean;
    config?: Record<string, unknown>;
  } | null;
  if (!body) return apiError('Invalid JSON body');

  try {
    const result = await saveAppState({
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      appId,
      enabled: Boolean(body.enabled),
      config: body.config,
    });
    return apiResponse(ctx, {
      ok: true,
      app_id: appId,
      state: maskAppState(def.id, result.state),
      affects_build: result.affectsBuild,
    }, 200, {
      enabled: Boolean(body.enabled),
      config_keys: Object.keys(body.config ?? {}),
    });
  } catch (error) {
    if (error instanceof AppManagementError) return apiError(error.message, error.status);
    return apiError('Failed to save app config', 500);
  }
};
