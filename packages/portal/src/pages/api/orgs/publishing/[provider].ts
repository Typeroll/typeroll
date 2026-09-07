import type { APIRoute } from 'astro';
import { ConnectionError, disconnect } from '../../../../lib/publishing/connections';
import { connectCloudflare } from '../../../../lib/publishing/cloudflare-connection';
import { GITHUB_COOKIE, startGithubConnection, selectGithubOrganization } from '../../../../lib/publishing/github-connection';
import { connectionBody, connectionFailure, privateJson, publishingAdmin } from '../../../../lib/publishing/http';

export const POST: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const body = await connectionBody(context.request) as Record<string, unknown>;
    if (context.params.provider === 'cloudflare') {
      await connectCloudflare(guard.value, body);
      return privateJson({ connected: true });
    }
    if (context.params.provider !== 'github') throw new ConnectionError('Unknown publishing provider', 404);
    if (typeof body.installation_id === 'string') {
      await selectGithubOrganization(guard.value, body.installation_id);
      return privateJson({ connected: true });
    }
    const result = await startGithubConnection(guard.value, typeof body?.owner === 'string' ? body.owner.trim() : '');
    context.cookies.set(GITHUB_COOKIE, result.browser, { path: '/api/orgs/publishing/github', httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || context.url.protocol === 'https:', sameSite: 'lax', maxAge: result.maxAge });
    return privateJson({ authorization_url: result.url });
  } catch (error) { return connectionFailure(error); }
};

export const DELETE: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const provider = context.params.provider;
    if (provider !== 'github' && provider !== 'cloudflare') throw new ConnectionError('Unknown publishing provider', 404);
    const body = await connectionBody(context.request) as { revision?: unknown };
    if (typeof body?.revision !== 'string') throw new ConnectionError('Connection revision is required');
    await disconnect(guard.value.orgId, provider, body.revision);
    return privateJson({ disconnected: true });
  } catch (error) { return connectionFailure(error); }
};
