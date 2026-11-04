// GET    /api/v1/sites/{siteId}/integrations/form-spam-protection   Turnstile setup (secret masked)
// PUT    /api/v1/sites/{siteId}/integrations/form-spam-protection   { provider: "turnstile", site_key, secret_key }
// DELETE /api/v1/sites/{siteId}/integrations/form-spam-protection   turn Turnstile off
//
// Cloudflare Turnstile for the site's forms. Admin permission; the secret is
// encrypted and only ever returned as { set: true }. Omit secret_key (or send
// the mask) to keep the stored secret for the same site key.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, type ApiContext } from '../../../../../../lib/api-auth';
import { FormSpamProtectionError, readFormSpamProtection, removeFormSpamProtection, saveFormSpamProtection } from '../../../../../../lib/forms/turnstile';

async function adminContext(request: Request, siteId: string | undefined): Promise<{ ok: true; ctx: ApiContext } | { ok: false; response: Response }> {
  const guard = await requireApiKey(request, siteId);
  if (!guard.ok) return guard;
  if (guard.value.permission !== 'admin') return { ok: false, response: apiError('Insufficient permission (admin required)', 403, guard.value) };
  return { ok: true, ctx: guard.value };
}

export const GET: APIRoute = async ({ request, params }) => {
  const access = await adminContext(request, params.siteId);
  if (!access.ok) return access.response;
  return apiResponse(access.ctx, await readFormSpamProtection(access.ctx.orgId, access.ctx.siteId));
};

export const PUT: APIRoute = async ({ request, params }) => {
  const access = await adminContext(request, params.siteId);
  if (!access.ok) return access.response;
  const { ctx } = access;
  const body = await request.json().catch(() => null) as { provider?: unknown; site_key?: unknown } | null;
  try {
    // The audit preview names the provider and public key, never the secret.
    return apiResponse(ctx, await saveFormSpamProtection(ctx.orgId, ctx.siteId, body), 200, { provider: body?.provider, site_key: body?.site_key });
  } catch (error) {
    if (error instanceof FormSpamProtectionError) return apiError(error.message, error.status, ctx);
    throw error;
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const access = await adminContext(request, params.siteId);
  if (!access.ok) return access.response;
  return apiResponse(access.ctx, await removeFormSpamProtection(access.ctx.orgId, access.ctx.siteId));
};
