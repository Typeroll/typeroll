// Receives the form POST from the consent page. Validates the pasted API
// key, issues a one-time authorization code (signed JWT, ~10 min TTL),
// then 302-redirects back to the OAuth client's redirect_uri with the
// code attached.

import type { APIRoute } from 'astro';
import { verifyApiToken } from '../../../../lib/api-keys';
import { issueToken, parseClientId } from '../../../../lib/mcp-tokens';

export const prerender = false;

function publicMcpUrl(request: Request): string {
  const fromEnv = process.env.PORTAL_PUBLIC_URL?.replace(/\/+$/, '');
  if (fromEnv) return `${fromEnv}/api/mcp`;
  return `${new URL(request.url).origin}/api/mcp`;
}

function redirectWithError(consentUrl: URL, message: string): Response {
  consentUrl.searchParams.set('error', message);
  // Relative Location: same-origin bounce back to the consent page. The
  // browser resolves it against the host it's on, so this is correct for the
  // hosted domain, any self-hosted domain, and localhost — no env config and
  // no risk of the Node adapter's "localhost" origin fallback leaking in.
  return new Response(null, {
    status: 302,
    headers: { Location: consentUrl.pathname + consentUrl.search },
  });
}

export const POST: APIRoute = async ({ request, url }) => {
  const form = await request.formData();
  const apiKey = String(form.get('api_key') ?? '').trim();
  const clientId = String(form.get('client_id') ?? '').trim();
  const redirectUri = String(form.get('redirect_uri') ?? '').trim();
  const codeChallenge = String(form.get('code_challenge') ?? '').trim();
  const state = String(form.get('state') ?? '');

  // Reconstruct the consent URL so we can bounce errors back to the same
  // page with all the params preserved. Base is only used for URL/param
  // convenience — redirectWithError emits the path+query relative.
  const consentUrl = new URL('/mcp/consent', url.origin);
  consentUrl.searchParams.set('client_id', clientId);
  consentUrl.searchParams.set('redirect_uri', redirectUri);
  consentUrl.searchParams.set('code_challenge', codeChallenge);
  if (state) consentUrl.searchParams.set('state', state);

  if (!apiKey || !clientId || !redirectUri || !codeChallenge) {
    return redirectWithError(consentUrl, 'Missing form fields.');
  }

  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    return redirectWithError(consentUrl, 'Invalid redirect URI.');
  }

  // Defense-in-depth: re-verify the signed client_id binds this
  // redirect_uri. /authorize already enforced this, but the consent form
  // round-trips through the user's browser and could be tampered with by
  // a malicious extension. If the signature breaks or the URI isn't in
  // the bound list, refuse to mint a code.
  const parsedClient = parseClientId(clientId);
  if (!parsedClient || !parsedClient.redirectUris.includes(redirectUri)) {
    return redirectWithError(
      consentUrl,
      'This consent form has been tampered with. Restart the connection flow in your MCP client.',
    );
  }

  const verified = await verifyApiToken(apiKey);
  if (!verified) {
    return redirectWithError(
      consentUrl,
      "That doesn't look like a valid Typeroll API key. Generate one in the portal's API keys settings and try again.",
    );
  }

  const { token: code } = issueToken({
    apiKey,
    audience: publicMcpUrl(request),
    kind: 'code',
    pkce: codeChallenge,
    redirectUri,
  });

  parsedRedirect.searchParams.set('code', code);
  if (state) parsedRedirect.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: { Location: parsedRedirect.toString() },
  });
};
