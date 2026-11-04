/**
 * One-step ways to add a Typeroll MCP server to common AI clients. Links only
 * prefill the client's own form; the person still confirms and signs in.
 * Formats, checked November 2026:
 * - Claude: https://claude.com/docs/connectors/building/directory-vs-custom
 * - Cursor: cursor://anysphere.cursor-deeplink/mcp/install?name=&config=<base64 JSON>
 * - VS Code: vscode:mcp/install?<URL-encoded JSON>
 */
export interface McpClientLinks {
  /** claude.ai and Claude Desktop: opens Add custom connector with the name and URL filled in. */
  claude: string;
  /** Team and Enterprise owners: the same dialog for the whole organization. */
  claude_organization: string;
  cursor: string;
  vscode: string;
  /** Run in a terminal, then sign in from `/mcp`. */
  claude_code: string;
  /** Adds the server and starts its sign-in. */
  codex: string;
}

const base64 = (text: string) => typeof btoa === 'function'
  ? btoa(String.fromCharCode(...new TextEncoder().encode(text)))
  : Buffer.from(text, 'utf8').toString('base64');

export function mcpClientLinks(endpoint: string, name = 'Typeroll'): McpClientLinks {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('MCP endpoint must use HTTPS');
  const href = url.href;
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'typeroll';
  const claude = (path: string) => `https://claude.ai/${path}?modal=add-custom-connector&connectorName=${encodeURIComponent(name)}&connectorUrl=${encodeURIComponent(href)}`;
  return {
    claude: claude('customize/connectors'),
    claude_organization: claude('admin-settings/connectors'),
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(id)}&config=${encodeURIComponent(base64(JSON.stringify({ url: href })))}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: id, type: 'http', url: href }))}`,
    claude_code: `claude mcp add --transport http ${id} ${href}`,
    codex: `codex mcp add ${id} --url ${href} && codex mcp login ${id}`,
  };
}
