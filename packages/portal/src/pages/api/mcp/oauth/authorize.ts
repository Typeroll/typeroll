// OAuth 2.1 /authorize endpoint for the MCP shim.
//
// Claude redirects the user's browser here with the standard OAuth params:
//   response_type=code
//   client_id=...
//   redirect_uri=https://claude.ai/api/mcp/auth_callback
//   code_challenge=...  (PKCE S256)
//   code_challenge_method=S256
//   state=...
//   scope=mcp                   (optional, ignored)
//   resource=https://.../api/mcp   (RFC 8707, optional, ignored — single resource)
//
// SECURITY: the redirect_uri MUST match a URI that the client_id committed
// to at /register. The id is a signed token carrying its registered
// redirect_uris (lib/mcp-tokens.signClientId), so we reject mismatches
// here without keeping a server-side client table — and an attacker can't
// reuse another client's id with their own redirect_uri because the
// signature won't verify.
//
// Behavior on success: render the consent page (a server-rendered Astro
// page), which captures the user's pasted API key. The form posts to
// /api/mcp/oauth/complete which validates the key and redirects back to
// redirect_uri with `?code=<jwt>&state=<state>`.

import type { APIRoute } from 'astro';
import { parseClientId } from '../../../../lib/mcp-tokens';

export const prerender = false;

const REQUIRED = ['response_type', 'client_id', 'redirect_uri', 'code_challenge'];

function badRequest(error: string, description?: string): Response {
  return new Response(
    JSON.stringify(description ? { error, error_description: description } : { error }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

export const GET: APIRoute = async ({ url }) => {
  const params = url.searchParams;
  for (const key of REQUIRED) {
    if (!params.get(key)) return badRequest('invalid_request', `Missing ${key}`);
  }
  if (params.get('response_type') !== 'code') {
    return badRequest('unsupported_response_type');
  }
  if (params.get('code_challenge_method') && params.get('code_challenge_method') !== 'S256') {
    return badRequest('invalid_request', 'Only S256 PKCE is supported');
  }

  const redirectUri = params.get('redirect_uri')!;
  try {
    new URL(redirectUri);
  } catch {
    return badRequest('invalid_redirect_uri');
  }

  // Verify the client_id signature and require the request's redirect_uri
  // to be in the set the client committed to at registration. This is the
  // bind that closes the OAuth phishing window: an attacker who crafts a
  // /authorize link with another client's id can't change where the code
  // gets sent.
  const parsedClient = parseClientId(params.get('client_id')!);
  if (!parsedClient) {
    return badRequest(
      'invalid_client',
      'client_id is unknown or has been tampered with. Re-run Dynamic Client Registration.',
    );
  }
  if (!parsedClient.redirectUris.includes(redirectUri)) {
    return badRequest(
      'invalid_request',
      'redirect_uri does not match any URI registered for this client_id.',
    );
  }

  // Hand the request off to the consent Astro page, preserving every query
  // param so the form POST can echo them back into the code-issuance step.
  //
  // The Location is RELATIVE on purpose. The consent page is same-origin, so
  // the browser resolves "/mcp/consent" against the host it's already on —
  // which is correct for the hosted domain, any self-hosted domain, and
  // localhost dev alike, with zero config. Building an absolute URL here from
  // `url.origin` is wrong under the Node adapter: when the served host isn't
  // in security.allowedDomains it falls back to bare "localhost", producing a
  // dead https://localhost/mcp/consent link. Let the browser do the resolving.
  const consentParams = new URLSearchParams();
  params.forEach((value, key) => consentParams.set(key, value));
  return new Response(null, {
    status: 302,
    headers: { Location: `/mcp/consent?${consentParams.toString()}` },
  });
};
