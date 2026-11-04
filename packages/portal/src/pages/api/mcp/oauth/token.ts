import { authClientAddress, limitAuthRequest, readAuthBody } from '../../../../lib/auth-request';
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
import { verifyApiToken, revokeVerifiedConnection } from '../../../../lib/api-keys';
import { issueToken, verifyToken, exchangeAuthorizationCode, newTokenId, startRefreshChain, advanceRefreshChain } from '../../../../lib/mcp-tokens';

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

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const limited = await limitAuthRequest(`mcp-token:${authClientAddress(request, clientAddress || 'unknown')}`, 120);
  if (limited) return limited;
  // RFC 6749 §3.2: token endpoint accepts application/x-www-form-urlencoded.
  // We tolerate JSON too because some MCP clients send that even though
  // the spec calls for form-encoded.
  let body: Record<string, string>;
  const ctype = request.headers.get('content-type') ?? '';
  if (ctype.includes('application/json')) {
    try {
      body = (JSON.parse(await readAuthBody(request))) as Record<string, string>;
    } catch {
      return err('invalid_request', 'Body must be JSON or x-www-form-urlencoded');
    }
  } else {
    let form: URLSearchParams;
    try { form = new URLSearchParams(await readAuthBody(request)); } catch { return err('invalid_request', 'Body must be JSON or x-www-form-urlencoded'); }
    body = {};
    form.forEach((v, k) => {
      body[k] = String(v);
    });
  }

  if (!body || typeof body !== 'object' || Object.values(body).some(v => typeof v !== 'string')) return err('invalid_request', 'Expected string form fields');
  const grant = body.grant_type;
  const audience = publicMcpUrl(request);
  if (body.resource && body.resource !== audience) return err('invalid_target', 'Resource does not match this MCP server');

  if (grant === 'authorization_code') {
    const code = body.code;
    const codeVerifier = body.code_verifier;
    const redirectUri = body.redirect_uri;
    if (!code || !codeVerifier || !redirectUri) {
      return err('invalid_request', 'code, code_verifier, redirect_uri required');
    }
    const apiKey = await exchangeAuthorizationCode({ code, audience, codeVerifier, redirectUri, clientId: body.client_id });
    if (!apiKey) return err('invalid_grant', 'Code is invalid, expired, already used, or does not match the request');
    // Re-validate the api_key so a key revoked between consent and token
    // exchange can't slip through.
    const live = await verifyApiToken(apiKey);
    if (!live) {
      return err('invalid_grant', 'This Typeroll connection was revoked, or its account no longer has access. Reconnect Typeroll in your assistant’s connector settings.');
    }
    const access = issueToken({ apiKey, audience, kind: 'access', clientId: body.client_id });
    const jti = newTokenId();
    const refresh = issueToken({ apiKey, audience, kind: 'refresh', clientId: body.client_id, jti });
    if (body.client_id) await startRefreshChain(live.prefix, body.client_id, jti);
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
      return err('invalid_grant', 'This Typeroll connection has expired or its refresh token is invalid. Reconnect Typeroll in your assistant’s connector settings.');
    }
    if (verified.clientId && body.client_id !== verified.clientId) return err('invalid_grant', 'Client does not match this connection');
    const live = await verifyApiToken(verified.apiKey);
    if (!live) {
      return err('invalid_grant', 'This Typeroll connection was revoked, or its account no longer has access. Reconnect Typeroll in your assistant’s connector settings.');
    }
    const nextJti = newTokenId();
    if (verified.clientId && !await advanceRefreshChain({ ...verified, clientId: verified.clientId }, live.prefix, nextJti)) {
      await revokeVerifiedConnection(live);
      return err('invalid_grant', 'This refresh token was used twice, so Typeroll revoked the connection to protect it. Reconnect Typeroll in your assistant’s connector settings.');
    }
    const access = issueToken({ apiKey: verified.apiKey, audience, kind: 'access', clientId: verified.clientId });
    const refresh = verified.clientId ? issueToken({ apiKey: verified.apiKey, audience, kind: 'refresh', clientId: verified.clientId, jti: nextJti }) : null;
    return new Response(
      JSON.stringify({
        token_type: 'Bearer',
        access_token: access.token,
        expires_in: access.expiresIn,
        ...(refresh ? { refresh_token: refresh.token } : {}),
        scope: 'mcp',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  return err('unsupported_grant_type', `Unsupported grant_type: ${grant ?? '(missing)'}`);
};
