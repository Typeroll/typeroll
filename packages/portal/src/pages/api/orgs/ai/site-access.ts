// PUT /api/orgs/ai/site-access — which of the Organization's own Sites may
// use its AI key: { mode: 'all' } (every Site, including future ones) or
// { mode: 'selected', site_ids: [...] }. Needs a key first (409
// ai_key_required). Organization owners and admins only.

import type { APIRoute } from 'astro';
import { requireOrganizationOwnerOrAdmin } from '../../../../lib/access';
import { setAiSiteAccess } from '../../../../lib/ai/organization-ai';
import { AI_SETTINGS_REFUSAL, aiJsonBody, aiSettingsFailure, privateJson } from '../../../../lib/ai/http';

export const PUT: APIRoute = async ({ cookies, request }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, AI_SETTINGS_REFUSAL);
  if (!guard.ok) return guard.response;
  try {
    const body = await aiJsonBody(request);
    return privateJson(await setAiSiteAccess(guard.value.orgId, { userId: guard.value.userId, email: guard.value.email }, body));
  } catch (error) { return aiSettingsFailure(error); }
};
