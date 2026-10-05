// GET /api/v1/publishing/cloudflare-diagnosis?hosting_group=<id> — why a
// Hosting Group's Cloudflare connection is or is not working: the outcome,
// each blocker, who must fix it (you, cloudflare_account_admin, publisher or
// typeroll_admin) and one action per fix, and the saved account once
// connected. Omit hosting_group for Default (the organization connection).
// A person's unfinished attempt stays private to them: no Typeroll user or
// Cloudflare accounts they authorized are returned.
//
// ?recheck=true re-verifies a saved connection with its own authorization
// (renewal, account access, Cloudflare Pages access, granted permissions) and
// stores the result. An API key cannot act as a person on Cloudflare: for an
// unfinished connection it returns the organization's state, and the person
// completes it at connect_url.
//
// Organization API key required, matching the organization owner/admin rule
// of the portal Publishing page. No tokens or provider responses are returned.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../lib/api-auth';
import { currentCloudflareDiagnosis } from '../../../../lib/publishing/cloudflare-diagnosis';
import { recheckCloudflareDiagnosis } from '../../../../lib/publishing/cloudflare-oauth';
import { getHostingGroup, hostingGroupId } from '../../../../lib/publishing/hosting-groups';
import { connectionFailure } from '../../../../lib/publishing/http';
import { PUBLISHING_SETTINGS_PATH } from '../../../../lib/publishing/organization-connections';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError('An organization API key is required to read the Cloudflare connection diagnosis.', 403, ctx);
  try {
    const parameters = new URL(request.url).searchParams;
    const groupId = hostingGroupId(parameters.get('hosting_group') ?? 'default');
    await getHostingGroup(ctx.tokenOrgId, groupId);
    const diagnosis = parameters.get('recheck') === 'true'
      ? await recheckCloudflareDiagnosis({ orgId: ctx.tokenOrgId, userId: `api-key:${ctx.keyPrefix}` }, groupId, { person: false })
      : await currentCloudflareDiagnosis(ctx.tokenOrgId, groupId);
    const base = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
    const connectUrl = `${base}${PUBLISHING_SETTINGS_PATH}${groupId === 'default' ? '#cloudflare' : `#hosting-${groupId}`}`;
    const response = apiResponse(ctx, { diagnosis, connect_url: connectUrl });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
};
