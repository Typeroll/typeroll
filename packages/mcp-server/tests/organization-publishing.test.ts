import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { buildServer } from '../src/server.js';

const organizationTools = [
  'check_organization_github_permissions', 'diagnose_organization_github_connection', 'diagnose_organization_cloudflare_connection',
  'setup_organization_build_engine', 'select_organization_build_provider', 'cancel_organization_build', 'set_organization_build_auto_update',
  'read_organization_build_engine', 'check_organization_build_access',
  'list_hosting_groups', 'save_hosting_group', 'connect_hosting_group',
  'list_organization_publishing_domains', 'configure_organization_publishing_domains',
  'read_organization_media_migration', 'retry_organization_media_migration',
  'read_organization_publishing_domains', 'set_organization_publishing_domains',
];

async function session(status = 200) {
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const api = new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'synthetic-org-key',
    fetchImpl: async (url, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      requests.push(String(url));
      return Response.json(status === 200 ? { groups: [] } : { error: 'Organization API key required' }, { status });
    },
  });
  const server = buildServer({ client: api, allowedSites: [] });
  const client = new Client({ name: 'organization-qualification', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, requests, bodies, close: async () => { await client.close(); await server.close(); } };
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

  it('tells agents that a queued build is normal and must not be retriggered', async () => {
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      const describe = (name: string) => tools.find(t => t.name === name)?.description ?? '';
      for (const term of ['build_progress.queue', 'waiting_for_provider', 'waiting_for_other_builds', 'provider_status', 'do not retrigger', 'build_queue_timeout', 'deadline is null'])
        expect(describe('get_deploy_status')).toContain(term);
      for (const term of ['build_progress.queue', 'do not trigger it again']) expect(describe('trigger_deploy')).toContain(term);
      for (const term of ['waiting_for_provider', 'waiting_for_other_builds', 'do not retrigger']) expect(describe('read_organization_build_engine')).toContain(term);
    } finally { await s.close(); }
  });

  it('diagnoses the GitHub connection without a site and re-checks only when asked', async () => {
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      const tool = tools.find(t => t.name === 'diagnose_organization_github_connection')!;
      for (const term of ['who must act', 'github_owner', 'publisher', 'connect_url', 'never returns credentials']) expect(tool.description).toContain(term);
      expect((await s.client.callTool({ name: 'diagnose_organization_github_connection', arguments: {} })).isError).not.toBe(true);
      expect((await s.client.callTool({ name: 'diagnose_organization_github_connection', arguments: { recheck: true } })).isError).not.toBe(true);
      expect(s.requests).toEqual(['https://example.test/api/v1/publishing/github-diagnosis', 'https://example.test/api/v1/publishing/github-diagnosis?recheck=true']);
    } finally { await s.close(); }
  });

  it('diagnoses a Cloudflare connection per Hosting Group without a site and re-checks only when asked', async () => {
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      const tool = tools.find(t => t.name === 'diagnose_organization_cloudflare_connection')!;
      for (const term of ['who must act', 'cloudflare_account_admin', 'publisher', 'connect_url', 'never returns credentials', 'hosting_group_id']) expect(tool.description).toContain(term);
      for (const args of [{}, { recheck: true }, { hosting_group_id: 'group-1' }, { hosting_group_id: 'group-1', recheck: true }]) {
        expect((await s.client.callTool({ name: 'diagnose_organization_cloudflare_connection', arguments: args })).isError).not.toBe(true);
      }
      expect(s.requests).toEqual([
        'https://example.test/api/v1/publishing/cloudflare-diagnosis',
        'https://example.test/api/v1/publishing/cloudflare-diagnosis?recheck=true',
        'https://example.test/api/v1/publishing/cloudflare-diagnosis?hosting_group=group-1',
        'https://example.test/api/v1/publishing/cloudflare-diagnosis?hosting_group=group-1&recheck=true',
      ]);
    } finally { await s.close(); }
  });

  it('pages through set-aside media and says that complete_with_failures is not success', async () => {
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      const tool = tools.find(t => t.name === 'read_organization_media_migration')!;
      for (const term of ['complete_with_failures', 'is not success', 'ok is true only', 'failed_media_next', 'failed_after', 'source_host', 'transient']) expect(tool.description).toContain(term);
      expect((await s.client.callTool({ name: 'read_organization_media_migration', arguments: {} })).isError).not.toBe(true);
      expect((await s.client.callTool({ name: 'read_organization_media_migration', arguments: { failed_after: 'moveria-de/image 1' } })).isError).not.toBe(true);
      expect(s.requests).toEqual(['https://example.test/api/v1/publishing/media-migration', 'https://example.test/api/v1/publishing/media-migration?failed_after=moveria-de%2Fimage%201']);
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

  it('sets up, selects and cancels GitHub builds with organization scope and exact payloads', async () => {
    const s = await session();
    try {
      expect((await s.client.callTool({ name: 'setup_organization_build_engine', arguments: { provider: 'github', revision: 'engine-revision' } })).isError).not.toBe(true);
      expect((await s.client.callTool({ name: 'select_organization_build_provider', arguments: { provider: 'github', revision: 'selection-revision' } })).isError).not.toBe(true);
      expect((await s.client.callTool({ name: 'cancel_organization_build', arguments: { key: 'a'.repeat(64) } })).isError).not.toBe(true);
      expect((await s.client.callTool({ name: 'set_organization_build_auto_update', arguments: { enabled: true, revision: 'selection-revision' } })).isError).not.toBe(true);
      expect(s.bodies).toEqual([{ provider: 'github', revision: 'engine-revision', action: 'setup' }, { provider: 'github', revision: 'selection-revision', action: 'select' }, { key: 'a'.repeat(64), action: 'cancel' },
        { enabled: true, revision: 'selection-revision', action: 'auto_update' }]);
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
