// Public-API handlers for the Organization's AI assistant settings:
//   GET    /api/v1/organization/ai              masked settings and Sites
//   PUT    /api/v1/organization/ai/key          { api_key } verify and store
//   DELETE /api/v1/organization/ai/key          remove; AI off on every Site
//   PUT    /api/v1/organization/ai/site-access  { mode, site_ids? }
//
// Organization API key required, matching the organization owner/admin rule
// of the portal page; a personal connection must select an Organization
// where the person is an owner or admin (requireAnyApiKey). A site-scoped
// key gets 403. The key is never returned, audited or echoed in an error.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey, withApiIdentity, type ApiContext } from '../api-auth';
import { aiJsonBody, aiSettingsFailure } from './http';
import { aiSettingsSummary, removeAiKey, setAiKey, setAiSiteAccess, type AiActor } from './organization-ai';

async function organizationKey(request: Request) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard;
  if (guard.value.tokenSiteId !== null) {
    return {
      ok: false as const,
      response: apiError('An organization API key is required to manage the Organization\'s AI assistant. This key is bound to a single site.', 403, guard.value),
    };
  }
  return guard;
}

function actor(ctx: ApiContext): AiActor {
  return { userId: ctx.personalUserId ?? `api-key:${ctx.keyPrefix}` };
}

function respond(ctx: ApiContext, data: unknown, audit?: unknown): Response {
  const response = apiResponse(ctx, data, 200, audit);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const getAiSettings: APIRoute = async ({ request }) => {
  const guard = await organizationKey(request);
  if (!guard.ok) return guard.response;
  try { return respond(guard.value, await aiSettingsSummary(guard.value.tokenOrgId)); }
  catch (error) { return withApiIdentity(guard.value, aiSettingsFailure(error)); }
};

export const putAiKey: APIRoute = async ({ request }) => {
  const guard = await organizationKey(request);
  if (!guard.ok) return guard.response;
  try {
    const body = await aiJsonBody(request);
    // Audit the action only; never the key.
    return respond(guard.value, await setAiKey(guard.value.tokenOrgId, actor(guard.value), body.api_key), { action: 'set_ai_key' });
  } catch (error) { return withApiIdentity(guard.value, aiSettingsFailure(error)); }
};

export const deleteAiKey: APIRoute = async ({ request }) => {
  const guard = await organizationKey(request);
  if (!guard.ok) return guard.response;
  try { return respond(guard.value, await removeAiKey(guard.value.tokenOrgId, actor(guard.value)), { action: 'remove_ai_key' }); }
  catch (error) { return withApiIdentity(guard.value, aiSettingsFailure(error)); }
};

export const putAiSiteAccess: APIRoute = async ({ request }) => {
  const guard = await organizationKey(request);
  if (!guard.ok) return guard.response;
  try {
    const body = await aiJsonBody(request);
    const summary = await setAiSiteAccess(guard.value.tokenOrgId, actor(guard.value), body);
    return respond(guard.value, summary, { action: 'set_ai_site_access', site_access: summary.site_access });
  } catch (error) { return withApiIdentity(guard.value, aiSettingsFailure(error)); }
};
