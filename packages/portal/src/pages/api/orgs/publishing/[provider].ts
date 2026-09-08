import { getHostingGroup, hostingGroupId } from '../../../../lib/publishing/hosting-groups';
import type { APIRoute } from 'astro';
import { ConnectionError, disconnect } from '../../../../lib/publishing/connections';
import { connectCloudflare, prepareCloudflareMedia, connectCloudflareMedia } from '../../../../lib/publishing/cloudflare-connection';
import { GITHUB_COOKIE, startGithubConnection, selectGithubOrganization } from '../../../../lib/publishing/github-connection';
import { connectionBody, connectionFailure, privateJson, publishingAdmin } from '../../../../lib/publishing/http';
import { CLOUDFLARE_COOKIE, startCloudflareConnection, selectCloudflareAccount } from '../../../../lib/publishing/cloudflare-oauth';

export const POST: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const body = await connectionBody(context.request) as Record<string, unknown>;
    if (context.params.provider === 'cloudflare') {
      const groupId = hostingGroupId(body.hosting_group_id ?? 'default');
      await getHostingGroup(guard.value.orgId, groupId);
      if (groupId !== 'default' && !['start', 'select'].includes(String(body.action))) throw new ConnectionError('Media storage belongs to the organization, not a Hosting Group.', 400);
      if (body.action === 'prepare_media' && typeof body.revision === 'string') return privateJson(await prepareCloudflareMedia(guard.value, body.revision));
      if (body.action === 'save_media') {
        await connectCloudflareMedia(guard.value, body);
        return privateJson({ media_ready: true });
      }
      if (body.action === 'start') {
        const result = await startCloudflareConnection(guard.value, groupId);
        context.cookies.set(CLOUDFLARE_COOKIE, result.browser, { path: '/api/orgs/publishing/cloudflare', httpOnly: true,
          secure: process.env.NODE_ENV === 'production' || context.url.protocol === 'https:', sameSite: 'lax', maxAge: result.maxAge });
        return privateJson({ authorization_url: result.url });
      }
      if (body.action === 'select' && typeof body.account_id === 'string') {
        await selectCloudflareAccount(guard.value, body.account_id, fetch, groupId);
        return privateJson({ connected: true });
      }
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
    const body = await connectionBody(context.request) as { revision?: unknown; hosting_group_id?: unknown };
    if (typeof body?.revision !== 'string') throw new ConnectionError('Connection revision is required');
    const groupId = hostingGroupId(body.hosting_group_id ?? 'default');
    await getHostingGroup(guard.value.orgId, groupId);
    await disconnect(guard.value.orgId, provider, body.revision, groupId);
    return privateJson({ disconnected: true });
  } catch (error) { return connectionFailure(error); }
};
