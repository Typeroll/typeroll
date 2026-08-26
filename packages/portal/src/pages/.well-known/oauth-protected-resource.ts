// RFC 9728 — Protected Resource Metadata. MCP clients (Claude Desktop /
// claude.ai) fetch this to discover where to authenticate. Per the spec
// it lives at the root path `/.well-known/oauth-protected-resource`, but
// Claude also accepts a resource-relative path and falls back to it; we
// surface both so users who paste either URL in "Add custom connector"
// land on a working endpoint.

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
      resource: `${base}/api/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      // Self-hosters benefit from the canonical URI being the base, so the
      // RFC 8707 `aud` claim matches whatever portal host issued the token.
      scopes_supported: ['mcp'],
      resource_documentation: `${base}/docs/getting-started/mcp-server`,
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
