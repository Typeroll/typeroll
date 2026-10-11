import type { APIRoute } from 'astro';
import { paths, isArchivedSite, type Site } from '@typeroll/shared';
import { getSession } from '../../../../lib/auth';
import { createApiKey, revokeApiKey } from '../../../../lib/api-keys';
import { issueAuthorizationCode } from '../../../../lib/mcp-tokens';
import { consentError, publicMcpUrl } from '../../../../lib/mcp-consent';
import { requireAuthOrigin, limitAuthRequest, readAuthBody } from '../../../../lib/auth-request';
import { organizationMembership } from '../../../../lib/organization-session';
import { getStore } from '../../../../lib/datastore';

export const prerender = false;
export const POST: APIRoute = async ({ request, cookies }) => {
  const origin = requireAuthOrigin(request);
  if (origin) return origin;
  const session = await getSession(cookies);
  if (!session) return new Response('Sign in again to approve this connection.', { status: 401 });
  const limited = await limitAuthRequest(`mcp-consent:${session.userId}`, 10, 600_000);
  if (limited) return limited;
  let form: URLSearchParams;
  try { form = new URLSearchParams(await readAuthBody(request)); } catch { return new Response('Invalid consent form.', { status: 400 }); }
  if (!['allow', 'deny'].includes(String(form.get('decision')))) return new Response('Choose Allow access or Cancel.', { status: 400 });
  const params = new URLSearchParams();
  for (const key of ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope']) {
    const value = form.get(key);
    if (typeof value === 'string' && value) params.set(key, value);
  }
  const error = consentError(params, publicMcpUrl(request));
  if (error) return new Response(error, { status: 400 });
  const redirect = new URL(params.get('redirect_uri')!);
  const state = params.get('state');
  if (state) redirect.searchParams.set('state', state);
  if (form.get('decision') === 'deny') {
    redirect.searchParams.set('error', 'access_denied');
  } else {
    const orgId = String(form.get('org_id') || '');
    const membership = await organizationMembership(session.userId, orgId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) return new Response('Only an organization owner or administrator can grant MCP access.', { status: 403 });
    const siteId = String(form.get('site_id') || '') || null;
    if (siteId && (/[\/\\]/.test(siteId) || siteId === '.' || siteId === '..')) return new Response('Invalid site.', { status: 400 });
    const site = siteId ? await getStore().getDoc<Site>(paths.site(orgId, siteId)) : null;
    if (siteId && (!site || isArchivedSite(site))) return new Response('Choose an active site owned by this organization.', { status: 403 });
    const created = await createApiKey({
      orgId, siteId, name: `MCP: ${redirect.host || redirect.protocol}`.slice(0, 80), createdBy: session.email,
      oauthUserId: session.userId,
    });
    try {
      const { token } = await issueAuthorizationCode({ apiKey: created.token, audience: publicMcpUrl(request),
        pkce: params.get('code_challenge')!, redirectUri: params.get('redirect_uri')!,
        clientId: params.get('client_id')!,
      });
      redirect.searchParams.set('code', token);
    } catch (error) {
      await revokeApiKey(orgId, siteId, created.key.id);
      throw error;
    }
  }
  return new Response(null, { status: 302, headers: {
    Location: redirect.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
};
