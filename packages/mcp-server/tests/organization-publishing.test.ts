import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { buildServer } from '../src/server.js';

const organizationTools = [
  'check_organization_github_permissions',
  'read_organization_build_engine', 'check_organization_build_access',
  'list_hosting_groups', 'save_hosting_group', 'connect_hosting_group',
  'list_organization_publishing_domains', 'configure_organization_publishing_domains',
  'read_organization_media_migration', 'retry_organization_media_migration',
  'read_organization_publishing_domains', 'set_organization_publishing_domains',
];

async function session(status = 200) {
  const requests: string[] = [];
  const api = new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'synthetic-org-key',
    fetchImpl: async (url) => {
      requests.push(String(url));
      return Response.json(status === 200 ? { groups: [] } : { error: 'Organization API key required' }, { status });
    },
  });
  const server = buildServer({ client: api, allowedSites: [] });
  const client = new Client({ name: 'organization-qualification', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, requests, close: async () => { await client.close(); await server.close(); } };
}

describe('organization publishing through the MCP transport', () => {
  it('does not require an existing site to discover or configure organization publishing', async () => {
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      for (const name of organizationTools) {
        const tool = tools.find(t => t.name === name);
        expect(tool, name).toBeDefined();
        expect(tool!.inputSchema.properties, name).not.toHaveProperty('site_id');
      }
      const listed = await s.client.callTool({ name: 'list_hosting_groups', arguments: {} });
      expect(listed.isError).not.toBe(true);
      const saved = await s.client.callTool({ name: 'save_hosting_group', arguments: {
        name: 'Default', sites_domain: 'sites.example.test', dns_mode: 'automatic',
      } });
      expect(saved.isError).not.toBe(true);
      expect(s.requests).toEqual(Array(2).fill('https://example.test/api/v1/publishing/hosting-groups'));
    } finally { await s.close(); }
  });

  it('checks GitHub permission updates without requiring a site', async () => {
    const s = await session();
    try {
      expect((await s.client.callTool({ name: 'check_organization_github_permissions', arguments: {} })).isError).not.toBe(true);
      expect(s.requests).toEqual(['https://example.test/api/v1/publishing/github-permissions']);
    } finally { await s.close(); }
  });

  it('checks organization build access without a site and forwards the revision', async () => {
    const s = await session();
    try {
      expect((await s.client.callTool({ name: 'read_organization_build_engine', arguments: {} })).isError).not.toBe(true);
      expect((await s.client.callTool({ name: 'check_organization_build_access', arguments: { revision: 'revision' } })).isError).not.toBe(true);
      expect(s.requests).toEqual(Array(2).fill('https://example.test/api/v1/publishing/builds'));
    } finally { await s.close(); }
  });

  it('still requires site access for site assignment', async () => {
    const s = await session();
    try {
      const result = await s.client.callTool({ name: 'read_site_hosting_group', arguments: { site_id: 'unavailable' } });
      expect(result.isError).toBe(true);
      expect(s.requests).toEqual([]);
    } finally { await s.close(); }
  });

  it('preserves organization authorization errors from the public API', async () => {
    const s = await session(403);
    try {
      const result = await s.client.callTool({ name: 'list_hosting_groups', arguments: {} });
      expect(result.isError).toBe(true);
      expect(s.requests).toHaveLength(1);
      expect(JSON.stringify(result.content)).toContain('Organization API key required');
    } finally { await s.close(); }
  });
});
