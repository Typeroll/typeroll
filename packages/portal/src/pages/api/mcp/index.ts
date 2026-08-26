// Hosted MCP endpoint — Streamable HTTP transport. This is the URL users
// paste into Claude Desktop's "Add custom connector".
//
// Auth: a bearer token in the Authorization header. Two shapes accepted:
//   1. typeroll_live_<prefix>_<secret> — the raw API key, for clients that
//      can pass headers directly (Claude Code CLI, curl, custom scripts).
//   2. A JWT issued by /api/mcp/oauth/token — what Claude Desktop / claude.ai
//      send after completing the OAuth shim flow. The JWT carries the
//      underlying API key as a claim, signed with MCP_OAUTH_SIGNING_KEY.
//
// Whichever shape arrives, the route ends up with an API key, then
// verifyApiToken() determines org + (optional) site binding and live-
// revocation status. Site-scoped keys produce a single-site server;
// org-scoped keys produce a multi-site server where every tool call
// must specify a `site_id` arg validated against the token's reachable
// sites (including sites shared in from other orgs).

import type { APIRoute } from 'astro';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from '@typeroll/mcp-server/server';
import { TyperollClient } from '@typeroll/mcp-server/client';
import { verifyApiToken } from '../../../lib/api-keys';
import { verifyToken } from '../../../lib/mcp-tokens';
import { listAllowedSites } from '../../../lib/api-auth';

export const prerender = false;

function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim() || null;
}

/**
 * Resolve "what API key does this Authorization header carry" — accepting
 * either a raw typeroll_live_ key or a JWT that wraps one. The two paths
 * converge on a single api_key string we feed to verifyApiToken().
 */
function resolveApiKey(rawToken: string, audience: string): string | null {
  if (rawToken.startsWith('typeroll_live_')) return rawToken;
  const verified = verifyToken(rawToken, audience);
  if (!verified) return null;
  if (verified.kind !== 'access') return null;
  return verified.apiKey;
}

function publicMcpUrl(request: Request): string {
  const fromEnv = process.env.PORTAL_PUBLIC_URL?.replace(/\/+$/, '');
  if (fromEnv) return `${fromEnv}/api/mcp`;
  const url = new URL(request.url);
  return `${url.origin}/api/mcp`;
}

function unauthorized(): Response {
  // The WWW-Authenticate header points Claude at the OAuth flow per RFC 9728.
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate':
        'Bearer realm="typeroll-mcp", resource_metadata="/.well-known/oauth-protected-resource"',
    },
  });
}

async function handle(request: Request): Promise<Response> {
  const token = bearer(request);
  if (!token) return unauthorized();
  const audience = publicMcpUrl(request);
  const apiKey = resolveApiKey(token, audience);
  if (!apiKey) return unauthorized();

  const verified = await verifyApiToken(apiKey);
  if (!verified) return unauthorized();

  const portalBase = process.env.PORTAL_PUBLIC_URL?.replace(/\/+$/, '') ?? new URL(request.url).origin;
  const client = new TyperollClient({ baseUrl: portalBase, apiKey });

  const server = verified.siteId !== null
    ? buildServer({ client, fixedSiteId: verified.siteId })
    : buildServer({
        client,
        allowedSites: (await listAllowedSites(verified.orgId, null)).map((s) => ({
          siteId: s.siteId,
          permission: s.permission,
          name: s.site.name,
        })),
      });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — each request stands alone, no session pinning.
    // Matches Cloud Run's "any instance can take any request" model.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST: APIRoute = async ({ request }) => handle(request);
export const GET: APIRoute = async ({ request }) => handle(request);
export const DELETE: APIRoute = async ({ request }) => handle(request);
