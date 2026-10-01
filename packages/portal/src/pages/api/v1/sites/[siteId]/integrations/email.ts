// GET    /api/v1/sites/{siteId}/integrations/email   connector (secrets masked) + providers
// PUT    /api/v1/sites/{siteId}/integrations/email   { type, from, reply_to?, config }
// DELETE /api/v1/sites/{siteId}/integrations/email   disconnect the connector
//
// The outgoing email connector that form notifications send through, exactly
// as in the portal's Settings → Email & notifications: admin permission, the provider's field
// schema for validation, secrets encrypted and only ever returned masked
// ({ set: true }). Omit a secret, or send the mask, to keep the stored one.
// The test send is POST ./email/test.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, type ApiContext } from '../../../../../../lib/api-auth';
import {
  EmailSettingsError,
  readEmailSettings,
  removeEmailSettings,
  saveEmailSettings,
  type EmailSettingsInput,
} from '../../../../../../lib/email/site-email-settings';

async function adminContext(request: Request, siteId: string | undefined): Promise<{ ok: true; ctx: ApiContext } | { ok: false; response: Response }> {
  const guard = await requireApiKey(request, siteId);
  if (!guard.ok) return guard;
  if (guard.value.permission !== 'admin') return { ok: false, response: apiError('Insufficient permission (admin required)', 403, guard.value) };
  return { ok: true, ctx: guard.value };
}

export const GET: APIRoute = async ({ request, params }) => {
  const access = await adminContext(request, params.siteId);
  if (!access.ok) return access.response;
  return apiResponse(access.ctx, await readEmailSettings(access.ctx.orgId, access.ctx.siteId));
};

export const PUT: APIRoute = async ({ request, params }) => {
  const access = await adminContext(request, params.siteId);
  if (!access.ok) return access.response;
  const { ctx } = access;
  const body = (await request.json().catch(() => null)) as EmailSettingsInput | null;
  try {
    const result = await saveEmailSettings(ctx.orgId, ctx.siteId, body);
    // The audit preview names what changed, never a credential.
    return apiResponse(ctx, result, 200, {
      type: body?.type,
      from: body?.from,
      config_keys: body?.config && typeof body.config === 'object' ? Object.keys(body.config) : [],
    });
  } catch (error) {
    if (error instanceof EmailSettingsError) return apiError(error.message, error.status, ctx);
    throw error;
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const access = await adminContext(request, params.siteId);
  if (!access.ok) return access.response;
  return apiResponse(access.ctx, await removeEmailSettings(access.ctx.orgId, access.ctx.siteId));
};
