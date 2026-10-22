// GET /api/orgs/ai — the signed-in organization's AI assistant settings:
// whether a key is set (last four characters, who set it and when), which
// Sites may use it, and the Organization's Sites. Never the key.
// Organization owners and admins only. The same data is served to API keys
// by GET /api/v1/organization/ai.

import type { APIRoute } from 'astro';
import { requireOrganizationOwnerOrAdmin } from '../../../../lib/access';
import { aiSettingsSummary } from '../../../../lib/ai/organization-ai';
import { AI_SETTINGS_REFUSAL, aiSettingsFailure, privateJson } from '../../../../lib/ai/http';

export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, AI_SETTINGS_REFUSAL);
  if (!guard.ok) return guard.response;
  try {
    return privateJson(await aiSettingsSummary(guard.value.orgId));
  } catch (error) { return aiSettingsFailure(error); }
};
