// GET /api/v1/publishing/github-diagnosis — why the organization's GitHub
// connection is or is not working: the outcome, each blocker, who must fix
// it (you, github_owner, publisher or typeroll_admin) and one action per
// fix, and the installation of a saved connection. A person's unfinished
// attempt stays private to them: no GitHub login, Typeroll user, other
// accounts or single sign-on links are returned.
//
// ?recheck=true re-checks the connected installation with the publisher
// App's own authority (suspension, repository access, permissions) and
// stores the result. An API key cannot act as a person on GitHub: for an
// unfinished connection it returns the organization's state, and the person
// completes or re-checks it at connect_url.
//
// Organization API key required, matching the organization owner/admin rule
// of the portal Publishing page. No tokens or provider responses are returned.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../lib/api-auth';
import { connectionFailure } from '../../../../lib/publishing/http';
import { currentGithubDiagnosis } from '../../../../lib/publishing/github-diagnosis';
import { recheckGithubDiagnosis } from '../../../../lib/publishing/github-recheck';
import { publishingConnectUrl } from '../../../../lib/publishing/organization-connections';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError('An organization API key is required to read the GitHub connection diagnosis.', 403, ctx);
  try {
    const recheck = new URL(request.url).searchParams.get('recheck') === 'true';
    const diagnosis = recheck
      ? await recheckGithubDiagnosis({ orgId: ctx.tokenOrgId, userId: `api-key:${ctx.keyPrefix}` }, { person: false })
      : await currentGithubDiagnosis(ctx.tokenOrgId);
    const response = apiResponse(ctx, { diagnosis, connect_url: publishingConnectUrl('github') });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
};
