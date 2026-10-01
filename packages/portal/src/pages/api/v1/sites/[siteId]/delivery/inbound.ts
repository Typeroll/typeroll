// GET /api/v1/sites/{siteId}/delivery/inbound   host-approved incoming email routes
// PUT /api/v1/sites/{siteId}/delivery/inbound   { route_id, revision, enabled }
//
// The same settings and validation as the portal's Settings → Email & notifications → Incoming
// email (lib/email/site-email-settings). Site admins read and write; an app
// with `email:inbound:status` reads only its own routes, without targets.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import {
  EmailSettingsError,
  readIncomingEmailSettings,
  saveIncomingEmailSetting,
} from '../../../../../../lib/email/site-email-settings';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity && ctx.permission !== 'admin') return apiError('Site administration is required', 403);
  try {
    return apiResponse(ctx, await readIncomingEmailSettings(ctx.orgId, ctx.siteId, ctx.extensionIdentity?.installationId));
  } catch (error) {
    if (error instanceof EmailSettingsError) return apiError(error.message, error.status, ctx);
    throw error;
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity || ctx.permission !== 'admin') return apiError('Site administration is required', 403);
  const body = await request.json().catch(() => null);
  try {
    return apiResponse(ctx, await saveIncomingEmailSetting(ctx.orgId, ctx.siteId, body), 200, body);
  } catch (error) {
    if (error instanceof EmailSettingsError) return apiError(error.message, error.status, ctx);
    throw error;
  }
};
