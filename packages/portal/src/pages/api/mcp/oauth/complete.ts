import type { APIRoute } from 'astro';
import { getSession } from '../../../../lib/auth';
import { createPersonalConnection, revokePersonalConnection } from '../../../../lib/api-keys';
import { issueAuthorizationCode } from '../../../../lib/mcp-tokens';
import { consentError, publicMcpUrl } from '../../../../lib/mcp-consent';
import { requireAuthOrigin, limitAuthRequest, readAuthBody } from '../../../../lib/auth-request';
import { listOrganizations } from '../../../../lib/organization-session';

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
    // Remember legacy membership before issuing an identity-bound connection.
    // The connection itself has no selected organization or inherited admin key.
    await listOrganizations(session);
    const created = await createPersonalConnection(session.userId, `MCP: ${redirect.host || redirect.protocol}`);
    try {
      const { token } = await issueAuthorizationCode({ apiKey: created.token, audience: publicMcpUrl(request),
        pkce: params.get('code_challenge')!, redirectUri: params.get('redirect_uri')!,
        clientId: params.get('client_id')!,
      });
      redirect.searchParams.set('code', token);
    } catch (error) {
      await revokePersonalConnection(session.userId, created.prefix);
      throw error;
    }
  }
  return new Response(null, { status: 302, headers: {
    Location: redirect.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
};
