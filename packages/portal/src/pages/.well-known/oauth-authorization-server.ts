// RFC 8414 — Authorization Server Metadata. Tells Claude where to send the
// user for /authorize, where to exchange codes at /token, and that we
// support PKCE + Dynamic Client Registration (RFC 7591) per the MCP auth
// spec (2025-06-18).

import type { APIRoute } from 'astro';

export const prerender = false;

function publicBase(request: Request): string {
  const fromEnv = process.env.PORTAL_PUBLIC_URL?.replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  return new URL(request.url).origin;
}

export const GET: APIRoute = async ({ request }) => {
  const base = publicBase(request);
  return new Response(
    JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
      token_endpoint: `${base}/api/mcp/oauth/token`,
      registration_endpoint: `${base}/api/mcp/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp'],
      // We accept any client redirect (per the OAuth shim design) — the
      // DCR endpoint just records what the caller registered.
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    },
  );
};
