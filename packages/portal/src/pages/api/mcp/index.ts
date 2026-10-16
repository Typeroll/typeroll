// Hosted MCP endpoint with Streamable HTTP transport.
// Accepts manual API keys and encrypted OAuth access tokens. Personal OAuth
// grants resolve live permissions and require a signed, explicit site context;
// legacy keys retain their fixed site or organization scope.

import type { APIRoute } from 'astro';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from '@typeroll/mcp-server/server';
import { TyperollClient } from '@typeroll/mcp-server/client';
import { verifyApiToken } from '../../../lib/api-keys';
import { rateLimit } from '../../../lib/rate-limit';
import { verifyToken } from '../../../lib/mcp-tokens';
import { resolvePersonalSite } from '../../../lib/personal-site-access';
import { issueSiteContext, verifySiteContext } from '../../../lib/mcp-site-context';
import { resolveRequestedVersion } from '../../../lib/access';
import { listAllowedSites } from '../../../lib/api-auth';

export const prerender = false;

function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim() || null;
}

/**
 * Resolve "what API key does this Authorization header carry" — accepting
 * either a raw typeroll_live_ key or an encrypted OAuth access token. The two paths
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
  const limited = rateLimit(`mcp:${verified.prefix}`, 600, 60_000);
  if (!limited.allowed) return new Response('Too many MCP requests. Try again shortly.', { status: 429, headers: { 'Retry-After': '60' } });

  const portalBase = process.env.PORTAL_PUBLIC_URL?.replace(/\/+$/, '') ?? new URL(request.url).origin;
  const client = new TyperollClient({ baseUrl: portalBase, apiKey });

  const mode = new URL(request.url).searchParams.get('tools') ?? (verified.personalUserId ? 'compact' : 'full');
  if (!['full', 'compact'].includes(mode)) return new Response('Use tools=compact or tools=full', { status: 400 });
  const toolMode = mode as 'full' | 'compact';
  const personalUserId = verified.personalUserId;
  const resolveSelection = async (organizationId: string, siteId: string, version: string) => {
    // Revalidate the connection and membership on each call, including a batch request.
    if (!await verifyApiToken(apiKey)) throw new Error('Connection revoked. Reconnect your AI tool.');
    const selected = await resolvePersonalSite(personalUserId!, organizationId, siteId);
    if (!selected) throw new Error('This site is no longer accessible. Use list_sites.');
    const resolved = await resolveRequestedVersion(organizationId, siteId, version);
    if (!resolved.ok) throw new Error(`Unknown version "${version}". Select an existing version.`);
    return { ...selected, version: resolved.versionId };
  };
  const server = personalUserId ? buildServer({ client, toolMode, selection: {
    select: async (organizationId, siteId, version) => {
      const selected = await resolveSelection(organizationId, siteId, version);
      return { site_context: issueSiteContext({ organizationId, siteId, version: selected.version }, apiKey),
        organization_id: organizationId, site_id: siteId, name: selected.site.name,
        version: selected.version, permission: selected.permission,
        next: 'Read relevant skills, site settings and enabled app documentation before editing. Keep this context for this conversation only.' };
    },
    resolve: async context => {
      const decoded = verifySiteContext(context, apiKey);
      if (!decoded) throw new Error('Missing, expired or invalid site_context. Confirm the site and use select_site again.');
      const selected = await resolveSelection(decoded.organizationId, decoded.siteId, decoded.version);
      return { client: client.forOrganization(decoded.organizationId, decoded.siteId, decoded.version), siteId: decoded.siteId, permission: selected.permission };
    },
  } }) : verified.siteId !== null
    ? buildServer({ client, fixedSiteId: verified.siteId, toolMode })
    : buildServer({
        client, toolMode,
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
