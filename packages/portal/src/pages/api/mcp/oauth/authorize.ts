import type { APIRoute } from 'astro';
import { consentError, publicMcpUrl } from '../../../../lib/mcp-consent';
export const prerender = false;
export const GET: APIRoute = async ({ url, request }) => {
  const error = url.searchParams.get('response_type') !== 'code'
    ? 'Only authorization code requests are supported.' : consentError(url.searchParams, publicMcpUrl(request));
  if (error) return new Response(JSON.stringify({ error: 'invalid_request', error_description: error }), {
    status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  return new Response(null, { status: 302, headers: {
    Location: `/mcp/consent?${url.searchParams}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
};
