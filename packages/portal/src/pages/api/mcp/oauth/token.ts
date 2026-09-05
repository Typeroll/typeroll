// OAuth 2.1 /token endpoint for the MCP shim.
//
// Two grant types supported:
//   - authorization_code: exchange a code (from /authorize → /complete) for
//     an access_token + refresh_token. Verifies PKCE code_verifier matches
//     the original code_challenge, and that redirect_uri matches what was
//     used at /authorize.
//   - refresh_token: re-issue an access_token from a still-valid refresh
//     token. Re-runs verifyApiToken on the embedded api_key so a revoked
//     key invalidates the refresh chain.

import type { APIRoute } from 'astro';
import { verifyApiToken } from '../../../../lib/api-keys';
import { issueToken, verifyToken, exchangeAuthorizationCode } from '../../../../lib/mcp-tokens';

export const prerender = false;

function publicMcpUrl(request: Request): string {
  const fromEnv = process.env.PORTAL_PUBLIC_URL?.replace(/\/+$/, '');
  if (fromEnv) return `${fromEnv}/api/mcp`;
  return `${new URL(request.url).origin}/api/mcp`;
}

function err(code: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // RFC 6749 §3.2: token endpoint accepts application/x-www-form-urlencoded.
  // We tolerate JSON too because some MCP clients send that even though
  // the spec calls for form-encoded.
  let body: Record<string, string>;
  const ctype = request.headers.get('content-type') ?? '';
  if (ctype.includes('application/json')) {
    try {
      body = (await request.json()) as Record<string, string>;
    } catch {
      return err('invalid_request', 'Body must be JSON or x-www-form-urlencoded');
    }
  } else {
    const form = await request.formData();
    body = {};
    form.forEach((v, k) => {
      body[k] = String(v);
    });
  }

  const grant = body.grant_type;
  const audience = publicMcpUrl(request);

  if (grant === 'authorization_code') {
    const code = body.code;
    const codeVerifier = body.code_verifier;
    const redirectUri = body.redirect_uri;
    if (!code || !codeVerifier || !redirectUri) {
      return err('invalid_request', 'code, code_verifier, redirect_uri required');
    }
    const apiKey = await exchangeAuthorizationCode({ code, audience, codeVerifier, redirectUri });
    if (!apiKey) return err('invalid_grant', 'Code is invalid, expired, already used, or does not match the request');
    // Re-validate the api_key so a key revoked between consent and token
    // exchange can't slip through.
    const live = await verifyApiToken(apiKey);
    if (!live) {
      return err('invalid_grant', 'Underlying API key has been revoked');
    }
    const access = issueToken({ apiKey, audience, kind: 'access' });
    const refresh = issueToken({ apiKey, audience, kind: 'refresh' });
    return new Response(
      JSON.stringify({
        token_type: 'Bearer',
        access_token: access.token,
        expires_in: access.expiresIn,
        refresh_token: refresh.token,
        scope: 'mcp',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  if (grant === 'refresh_token') {
    const refreshToken = body.refresh_token;
    if (!refreshToken) return err('invalid_request', 'refresh_token required');
    const verified = verifyToken(refreshToken, audience);
    if (!verified || verified.kind !== 'refresh') {
      return err('invalid_grant', 'Refresh token is invalid or expired');
    }
    const live = await verifyApiToken(verified.apiKey);
    if (!live) {
      return err('invalid_grant', 'Underlying API key has been revoked');
    }
    const access = issueToken({ apiKey: verified.apiKey, audience, kind: 'access' });
    return new Response(
      JSON.stringify({
        token_type: 'Bearer',
        access_token: access.token,
        expires_in: access.expiresIn,
        scope: 'mcp',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  return err('unsupported_grant_type', `Unsupported grant_type: ${grant ?? '(missing)'}`);
};
