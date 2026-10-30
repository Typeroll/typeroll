// Bearer-authenticated app configuration. Admin-scoped API keys use the same
// schema validation, secret handling, and provisioning service as the portal.

import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { maskAppState } from '../../../../../../lib/apps/config';
import { AppManagementError, incompleteSetupError, saveAppState } from '../../../../../../lib/apps/manage';
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
    app_id: def.id,
    state,
    // Provider setup (Analytics: Cloudflare Web Analytics site): ready, or the cause and next step.
    setup: state.setup ?? null,
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

// PUT sets enabled from the body (absent means false); PATCH keeps the current
// value when the body leaves it out. Config fields merge in both: omitted ones are kept.
const save = (partial: boolean): APIRoute => async ({ request, params }) => {
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
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return apiError('enabled must be a boolean');
  const enabled = partial && body.enabled === undefined
    ? Boolean((await getStore().getDoc<SiteApps>(paths.apps(ctx.orgId, ctx.siteId)))?.apps?.[def.id]?.enabled)
    : Boolean(body.enabled);

  try {
    const result = await saveAppState({
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      appId,
      enabled,
      config: body.config,
    });
    const state = maskAppState(def.id, result.state);
    // Saved, but the app cannot work yet (Analytics without a beacon): answer with the cause, not ok.
    const incomplete = incompleteSetupError(appId, result.state, result.setup);
    if (incomplete) {
      return apiError(incomplete.message, incomplete.status, ctx, {
        code: incomplete.code,
        details: { ...incomplete.details, app_id: appId, saved: true, state, affects_build: result.affectsBuild },
      });
    }
    return apiResponse(ctx, {
      ok: true,
      app_id: appId,
      state,
      setup: result.setup,
      affects_build: result.affectsBuild,
    }, 200, {
      enabled,
      config_keys: Object.keys(body.config ?? {}),
    });
  } catch (error) {
    if (error instanceof AppManagementError) {
      return apiError(error.message, error.status, ctx, error.code ? { code: error.code, details: { ...error.details, app_id: appId, saved: false } } : undefined);
    }
    return apiError('Failed to save app config', 500);
  }
};

export const PUT = save(false);
export const PATCH = save(true);
