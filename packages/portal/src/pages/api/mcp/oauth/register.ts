// RFC 7591 Dynamic Client Registration endpoint for the MCP OAuth shim.
//
// Open registration (per the MCP auth spec) — anyone can register. The
// returned `client_id` is a **signed** identifier that carries the
// requested `redirect_uris` as a tamper-proof claim, so /authorize can
// later verify the redirect_uri the client presents matches what was
// registered without us keeping any server-side client table. See
// lib/mcp-tokens.signClientId for the format.

import type { APIRoute } from 'astro';
import { signClientId } from '../../../../lib/mcp-tokens';

export const prerender = false;

interface RegisterRequest {
  redirect_uris?: string[];
  client_name?: string;
  // …other RFC 7591 fields tolerated but ignored
}

const MAX_REDIRECT_URIS = 8;
const MAX_REDIRECT_URI_LEN = 2048;

export const POST: APIRoute = async ({ request }) => {
  let body: RegisterRequest;
  try {
    body = (await request.json()) as RegisterRequest;
  } catch {
    return json({ error: 'invalid_request', error_description: 'Body must be JSON' }, 400);
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];
  if (redirectUris.length === 0) {
    return json(
      { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' },
      400,
    );
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return json(
      {
        error: 'invalid_redirect_uri',
        error_description: `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered`,
      },
      400,
    );
  }
  // Reject obviously malformed URIs up-front so the signed payload stays
  // tidy. Permissive on scheme/host because self-hosted MCP clients use
  // custom schemes (e.g. `cursor://oauth/callback`) and any host.
  for (const uri of redirectUris) {
    if (uri.length > MAX_REDIRECT_URI_LEN) {
      return json(
        {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uri exceeds maximum length',
        },
        400,
      );
    }
    try {
      new URL(uri);
    } catch {
      return json(
        { error: 'invalid_redirect_uri', error_description: `Malformed redirect_uri: ${uri}` },
        400,
      );
    }
  }

  const clientId = signClientId(redirectUris);
  const now = Math.floor(Date.now() / 1000);

  return json(
    {
      client_id: clientId,
      client_id_issued_at: now,
      // No secret — we run as a public client with PKCE per the MCP auth
      // spec. Confidential-client support would mean storing secrets we
      // don't actually verify against, since the OAuth shim trusts only
      // the user's pasted API key (validated at /authorize).
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: redirectUris,
      client_name: body.client_name ?? 'MCP Client',
    },
    201,
  );
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
