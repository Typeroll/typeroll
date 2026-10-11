import { parseClientId } from './mcp-tokens';

export function publicMcpUrl(request: Request): string {
  return `${(process.env.PORTAL_PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, '')}/api/mcp`;
}

export function validRedirectUri(value: string): boolean {
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.hash) return false;
    if (uri.protocol === 'https:') return true;
    if (uri.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname);
    // Native applications must use a reverse-domain private scheme.
    return /^[a-z][a-z0-9+-]*(?:\.[a-z0-9+-]+)+:$/.test(uri.protocol);
  } catch { return false; }
}

export function consentError(params: URLSearchParams, audience: string): string | null {
  const client = parseClientId(params.get('client_id') || '');
  const redirect = params.get('redirect_uri') || '';
  if (!client || !validRedirectUri(redirect) || !client.redirectUris.includes(redirect)) return 'Invalid client or callback address. Restart the connection from your MCP client.';
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '')) return 'This connection requires S256 PKCE. Restart it from your MCP client.';
  if (params.has('resource') && params.get('resource') !== audience) return 'This request targets a different MCP server.';
  if (params.get('scope') && params.get('scope') !== 'mcp') return 'Unsupported access scope.';
  if ((params.get('state') || '').length > 2048) return 'Invalid connection state.';
  return null;
}
