import type { APIRoute } from 'astro';
import { githubChoices, githubReturnState } from '../../../../lib/publishing/github-connection';
import { currentGithubDiagnosis } from '../../../../lib/publishing/github-diagnosis';
import { connectionFailure, privateJson, publishingAdmin } from '../../../../lib/publishing/http';
import { cloudflareChoices } from '../../../../lib/publishing/cloudflare-oauth';
import { organizationConnectionsStatus } from '../../../../lib/publishing/organization-connections';

// The shared status is also served by GET /api/v1/publishing/connections.
// Choices, the unfinished attempt and its return state belong to the signed-in person's own OAuth flow.
export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    return privateJson({ ...await organizationConnectionsStatus(guard.value.orgId),
      cloudflare_choices: await cloudflareChoices(guard.value),
      github_choices: await githubChoices(guard.value),
      github_diagnosis: await currentGithubDiagnosis(guard.value.orgId, guard.value),
      github_attempt: await githubReturnState(guard.value) });
  } catch (error) { return connectionFailure(error); }
};
