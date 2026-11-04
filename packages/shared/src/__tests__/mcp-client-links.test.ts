import { describe, expect, it } from 'vitest';
import { mcpClientLinks } from '../mcp-client-links.js';

describe('MCP client links', () => {
  const links = mcpClientLinks('https://app.typeroll.com/api/mcp');
  it('prefills Claude\'s Add custom connector dialog with the documented parameters', () => {
    expect(links.claude).toBe('https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Typeroll&connectorUrl=https%3A%2F%2Fapp.typeroll.com%2Fapi%2Fmcp');
    expect(links.claude_organization).toBe('https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Typeroll&connectorUrl=https%3A%2F%2Fapp.typeroll.com%2Fapi%2Fmcp');
  });
  it('keeps the Cursor link the docs already publish, and adds VS Code', () => {
    expect(links.cursor).toBe('cursor://anysphere.cursor-deeplink/mcp/install?name=typeroll&config=eyJ1cmwiOiJodHRwczovL2FwcC50eXBlcm9sbC5jb20vYXBpL21jcCJ9');
    expect(JSON.parse(decodeURIComponent(links.vscode.slice('vscode:mcp/install?'.length)))).toEqual({ name: 'typeroll', type: 'http', url: 'https://app.typeroll.com/api/mcp' });
  });
  it('gives one command each for Claude Code and Codex', () => {
    expect(links.claude_code).toBe('claude mcp add --transport http typeroll https://app.typeroll.com/api/mcp');
    expect(links.codex).toBe('codex mcp add typeroll --url https://app.typeroll.com/api/mcp && codex mcp login typeroll');
  });
  it('uses a self-hosted portal address and refuses plain HTTP elsewhere', () => {
    expect(mcpClientLinks('https://cms.example.org/api/mcp').claude).toContain('connectorUrl=https%3A%2F%2Fcms.example.org%2Fapi%2Fmcp');
    expect(() => mcpClientLinks('http://cms.example.org/api/mcp')).toThrow('HTTPS');
  });
});
