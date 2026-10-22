// PUT    /api/orgs/ai/key { api_key } — verify the Anthropic key with
//        Anthropic, then store it encrypted. Nothing is stored when Anthropic
//        rejects it (422 ai_key_rejected) or cannot be reached (502
//        ai_key_unverified). A first key has no Sites selected.
// DELETE /api/orgs/ai/key — remove the key; AI turns off on every Site.
// Organization owners and admins only; same-origin requests (middleware).

import type { APIRoute } from 'astro';
import { requireOrganizationOwnerOrAdmin } from '../../../../lib/access';
import { removeAiKey, setAiKey } from '../../../../lib/ai/organization-ai';
import { AI_SETTINGS_REFUSAL, aiJsonBody, aiSettingsFailure, privateJson } from '../../../../lib/ai/http';

export const PUT: APIRoute = async ({ cookies, request }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, AI_SETTINGS_REFUSAL);
  if (!guard.ok) return guard.response;
  try {
    const body = await aiJsonBody(request);
    return privateJson(await setAiKey(guard.value.orgId, { userId: guard.value.userId, email: guard.value.email }, body.api_key));
  } catch (error) { return aiSettingsFailure(error); }
};

export const DELETE: APIRoute = async ({ cookies }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, AI_SETTINGS_REFUSAL);
  if (!guard.ok) return guard.response;
  try {
    return privateJson(await removeAiKey(guard.value.orgId, { userId: guard.value.userId, email: guard.value.email }));
  } catch (error) { return aiSettingsFailure(error); }
};
