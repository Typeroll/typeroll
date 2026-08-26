// GET /api/v1/sites/{siteId}/capabilities
//
// Returns the platform's capability manifest — what features the
// site-template renderer supports for this site. Agents read this
// before making structural changes (setting route_template, switching
// to blocks-mode, etc.) so a schema bump can fail fast with a clear
// reason instead of surfacing as a deploy crash.
//
// The manifest is platform-wide today (the same renderer runs for
// every site). When per-site renderer overrides land, this endpoint
// becomes per-site and a custom-template install can advertise its
// own capabilities here.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { SITE_TEMPLATE_CAPABILITIES } from '@typeroll/shared';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return apiResponse(guard.value, { capabilities: SITE_TEMPLATE_CAPABILITIES });
};
