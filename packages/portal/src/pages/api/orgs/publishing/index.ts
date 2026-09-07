import type { APIRoute } from 'astro';
import { connectionSummary, getConnection } from '../../../../lib/publishing/connections';
import { githubSetup, githubChoices } from '../../../../lib/publishing/github-connection';
import { isSecretCryptoConfigured } from '../../../../lib/secret-crypto';
import { connectionFailure, privateJson, publishingAdmin } from '../../../../lib/publishing/http';

export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const orgId = guard.value.orgId;
    return privateJson({ github: connectionSummary(await getConnection(orgId, 'github')),
      cloudflare: connectionSummary(await getConnection(orgId, 'cloudflare')),
      github_choices: await githubChoices(guard.value), github_setup: githubSetup(), encryption_available: isSecretCryptoConfigured() });
  } catch (error) { return connectionFailure(error); }
};
