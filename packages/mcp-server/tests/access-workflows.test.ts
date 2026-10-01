// MCP tools for API keys, site sharing, invites, workflows, site creation
// with a first workflow, and organization publishing connections. Each tool
// is one authenticated public-API call; these pin method, URL and body, and
// that the multi-site permission gate classifies them like the portal does.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { buildServer, type AllowedSite } from '../src/server.js';

interface Recorded { method: string; url: string; body: unknown }

async function session(allowedSites: AllowedSite[] = [], status = 200) {
  const calls: Recorded[] = [];
  const api = new TyperollClient({
    baseUrl: 'https://example.test', apiKey: 'synthetic-org-key',
    fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json(status === 200 ? { ok: true } : { error: 'Insufficient permission' }, { status });
    },
  });
  const server = buildServer({ client: api, allowedSites });
  const client = new Client({ name: 'access-qualification', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, calls, call, close: async () => { await client.close(); await server.close(); } };
}

const admin: AllowedSite[] = [{ siteId: 'site', permission: 'admin' }];

describe('site access tools', () => {
  it('manage site keys and shares through the site routes', async () => {
    const s = await session(admin);
    try {
      for (const [name, args] of [
        ['list_api_keys', {}],
        ['revoke_api_key', { key_id: 'abcdefabcdef' }],
        ['list_site_shares', {}],
        ['share_site', { org_slug: 'client', permission: 'read' }],
        ['update_site_share', { share_id: 'share-1', permission: 'write' }],
        ['revoke_site_share', { share_id: 'share-1' }],
      ] as const) {
        expect((await s.call(name, { ...args, site_id: 'site' })).isError, name).not.toBe(true);
      }
      expect(s.calls.map(c => `${c.method} ${c.url.replace('https://example.test/api/v1/', '')}`)).toEqual([
        'GET sites/site/api-keys',
        'DELETE sites/site/api-keys/abcdefabcdef',
        'GET sites/site/shares',
        'POST sites/site/shares',
        'PATCH sites/site/shares/share-1',
        'DELETE sites/site/shares/share-1',
      ]);
      expect(s.calls[4]!.body).toEqual({ permission: 'write' });
    } finally { await s.close(); }
  });

  it('refuses key and sharing management on a write-only share before any request', async () => {
    const s = await session([{ siteId: 'site', permission: 'write' }]);
    try {
      for (const name of ['revoke_api_key', 'list_site_shares', 'share_site', 'revoke_site_share']) {
        const args = name === 'revoke_api_key' ? { key_id: 'abcdefabcdef' } : name === 'revoke_site_share' ? { share_id: 's' } : { org_id: 'o' };
        const result = await s.call(name, { ...args, site_id: 'site' });
        expect(result.isError, name).toBe(true);
        expect(JSON.stringify(result.content)).toContain('requires admin permission');
      }
      expect((await s.call('list_api_keys', { site_id: 'site' })).isError).not.toBe(true);
      expect(s.calls).toHaveLength(1);
    } finally { await s.close(); }
  });
});

describe('new secrets', () => {
  it('are never minted through MCP, so they stay out of agent conversations', async () => {
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      for (const name of ['create_api_key', 'create_organization_api_key', 'rotate_extension_credential', 'create_developer_extension', 'rotate_extension_client_secret'])
        expect(tools.find(t => t.name === name), name).toBeUndefined();
    } finally { await s.close(); }
  });
});

describe('organization access tools', () => {
  it('manage organization keys and invites without a site', async () => {
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      for (const name of ['list_organization_api_keys', 'revoke_organization_api_key', 'create_organization_invite',
        'create_site_and_migrate', 'create_site_and_plan', 'read_organization_publishing_connections',
        'disconnect_organization_publishing_provider', 'connect_organization_cloudflare', 'prepare_organization_media_storage', 'save_organization_media_access']) {
        const tool = tools.find(t => t.name === name);
        expect(tool, name).toBeDefined();
        expect(tool!.inputSchema.properties ?? {}, name).not.toHaveProperty('site_id');
      }
      await s.call('list_organization_api_keys');
      await s.call('revoke_organization_api_key', { key_id: 'abcdefabcdef' });
      await s.call('create_organization_invite', { ttl_days: 14 });
      expect(s.calls.map(c => `${c.method} ${c.url.replace('https://example.test/api/v1/', '')}`)).toEqual([
        'GET organization/api-keys', 'DELETE organization/api-keys/abcdefabcdef', 'POST organization/invites',
      ]);
      expect(s.calls[2]!.body).toEqual({ ttl_days: 14 });
    } finally { await s.close(); }
  });

  it('surfaces the 403 a site-scoped key receives', async () => {
    const s = await session([], 403);
    try {
      const result = await s.call('list_organization_api_keys');
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('403');
    } finally { await s.close(); }
  });
});

describe('workflow tools', () => {
  it('start, read, list and approve workflows on the selected site and version', async () => {
    const s = await session(admin);
    try {
      await s.call('start_workflow', { site_id: 'site', type: 'seo_audit', version: 'redesign' });
      await s.call('get_workflow', { site_id: 'site', workflow_id: 'wf_1_abc' });
      await s.call('list_workflows', { site_id: 'site', limit: 5 });
      await s.call('approve_workflow', { site_id: 'site', workflow_id: 'wf_1_abc' });
      expect(s.calls.map(c => `${c.method} ${c.url.replace('https://example.test/api/v1/', '')}`)).toEqual([
        'POST sites/site/workflows?version=redesign',
        'GET sites/site/workflows/wf_1_abc',
        'GET sites/site/workflows?limit=5',
        'POST sites/site/workflows/wf_1_abc/approve',
      ]);
      expect(s.calls[0]!.body).toEqual({ type: 'seo_audit' });
    } finally { await s.close(); }
  });

  it('lets a read share inspect runs but not start or approve them', async () => {
    const s = await session([{ siteId: 'site', permission: 'read' }]);
    try {
      expect((await s.call('get_workflow', { site_id: 'site', workflow_id: 'wf' })).isError).not.toBe(true);
      expect((await s.call('start_workflow', { site_id: 'site', type: 'seo_audit' })).isError).toBe(true);
      expect((await s.call('approve_workflow', { site_id: 'site', workflow_id: 'wf' })).isError).toBe(true);
      expect(s.calls).toHaveLength(1);
    } finally { await s.close(); }
  });

  it('creates a site with its first workflow through the organization routes', async () => {
    const s = await session();
    try {
      await s.call('create_site_and_migrate', { name: 'Old Blog', wp_url: 'https://wp.example' });
      await s.call('create_site_and_plan', { name: 'Harbor Bakery', business_description: 'Bakery.' });
      expect(s.calls.map(c => `${c.method} ${c.url.replace('https://example.test/api/v1/', '')}`)).toEqual([
        'POST sites/create-and-migrate', 'POST sites/create-and-plan',
      ]);
      expect(s.calls[0]!.body).toEqual({ name: 'Old Blog', wp_url: 'https://wp.example' });
    } finally { await s.close(); }
  });
});

describe('organization publishing connection tools', () => {
  it('read, disconnect and finish Cloudflare setup with exact payloads', async () => {
    const s = await session();
    try {
      await s.call('read_organization_publishing_connections');
      await s.call('disconnect_organization_publishing_provider', { provider: 'github', revision: 'rev-1' });
      await s.call('connect_organization_cloudflare', { revision: 'rev-2', account_id: 'a'.repeat(32), bucket: 'media', api_token: 't', access_key_id: 'k', secret_access_key: 's' });
      await s.call('prepare_organization_media_storage', { revision: 'rev-3' });
      await s.call('save_organization_media_access', { revision: 'rev-4', access_key_id: 'k', secret_access_key: 's' });
      expect(s.calls.map(c => `${c.method} ${c.url.replace('https://example.test/api/v1/', '')}`)).toEqual([
        'GET publishing/connections',
        'DELETE publishing/connections/github',
        'POST publishing/connections/cloudflare',
        'POST publishing/connections/cloudflare',
        'POST publishing/connections/cloudflare',
      ]);
      expect(s.calls[1]!.body).toEqual({ revision: 'rev-1' });
      expect(s.calls.slice(2).map(c => (c.body as { action: string }).action)).toEqual(['connect', 'prepare_media', 'save_media']);
    } finally { await s.close(); }
  });
});
