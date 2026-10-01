// Request shapes and permission classes for the branch review/reset,
// partial revision, revision preview, Extension installation and Extension
// developer tools. Each tool is one REST call against the same route the
// portal UI's action uses through its session API.

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type BuildServerOptions } from '../src/server.js';
import { TyperollClient } from '../src/client.js';

interface Recorded { url: string; method: string; body: unknown }

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(client => client.close())); });

async function connect(mode: 'full' | 'compact' = 'full', overrides: Partial<BuildServerOptions> = {}) {
  const calls: Recorded[] = [];
  const api = new TyperollClient({
    baseUrl: 'https://portal.test', apiKey: 'typeroll_live_x_y',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ ok: true });
    },
  });
  const server = buildServer({ client: api, fixedSiteId: 'site', toolMode: mode, ...overrides });
  const client = new Client({ name: 'tools-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); connections.push(client);
  return { client, calls };
}

const cases: Array<[string, Record<string, unknown>, string, string, unknown?]> = [
  ['diff_version', { version_id: 'redesign' }, 'GET', '/api/v1/sites/site/versions/redesign/diff'],
  ['reset_version', { version_id: 'redesign' }, 'POST', '/api/v1/sites/site/versions/redesign/reset'],
  ['preview_page_revision', { page_id: 'home', revision_id: 'r1', annotate: true, version: 'redesign' }, 'GET', '/api/v1/sites/site/pages/home/revisions/r1/preview?version=redesign&annotate=true'],
  ['list_partial_revisions', { partial_id: 'header', limit: 5 }, 'GET', '/api/v1/sites/site/partials/header/revisions?limit=5'],
  ['read_partial_revision', { partial_id: 'header', revision_id: 'r1' }, 'GET', '/api/v1/sites/site/partials/header/revisions/r1'],
  ['restore_partial_revision', { partial_id: 'header', revision_id: 'r1', save: true }, 'POST', '/api/v1/sites/site/partials/header/revisions/r1/restore', { save: true }],
  ['install_extension', { extension_id: 'se.vendor.quotes', version: '1.0.0', granted_scopes: ['content:read'] }, 'POST', '/api/v1/sites/site/extensions', { extension_id: 'se.vendor.quotes', version: '1.0.0', granted_scopes: ['content:read'] }],
  ['set_extension_installation_status', { installation_id: 'inst/1', status: 'disabled' }, 'PATCH', '/api/v1/sites/site/extensions/inst%2F1', { status: 'disabled' }],
  ['uninstall_extension', { installation_id: 'inst-1' }, 'DELETE', '/api/v1/sites/site/extensions/inst-1'],
  ['pair_extension_issuer', { installation_id: 'inst-1' }, 'POST', '/api/v1/sites/site/extensions/inst-1/pair'],
  ['read_extension_diagnostics', { installation_id: 'inst-1' }, 'GET', '/api/v1/sites/site/extensions/inst-1/diagnostics'],
  ['launch_extension_admin_page', { installation_id: 'inst-1', page_id: 'quotes' }, 'POST', '/api/v1/sites/site/extensions/inst-1/launch', { page_id: 'quotes' }],
  ['list_developer_extensions', {}, 'GET', '/api/developer/extensions'],
  ['read_developer_extension', { extension_id: 'se.vendor.quotes' }, 'GET', '/api/developer/extensions/se.vendor.quotes'],
  ['update_developer_extension', { extension_id: 'se.vendor.quotes', status: 'suspended' }, 'PATCH', '/api/developer/extensions/se.vendor.quotes', { status: 'suspended' }],
  ['save_extension_version', { extension_id: 'se.vendor.quotes', manifest: { id: 'se.vendor.quotes' } }, 'POST', '/api/developer/extensions/se.vendor.quotes/versions', { manifest: { id: 'se.vendor.quotes' } }],
  ['publish_extension_version', { extension_id: 'se.vendor.quotes', version: '1.0.0' }, 'POST', '/api/developer/extensions/se.vendor.quotes/versions/1.0.0/publish'],
  ['set_extension_version_lifecycle', { extension_id: 'se.vendor.quotes', version: '1.0.0', status: 'revoked', reason: 'Broken' }, 'PATCH', '/api/developer/extensions/se.vendor.quotes/versions/1.0.0', { status: 'revoked', reason: 'Broken' }],
  ['list_developer_extension_installations', { extension_id: 'se.vendor.quotes', owner_org_id: 'customer', site_id: 'shop' }, 'GET', '/api/developer/extensions/se.vendor.quotes/installations?owner_org_id=customer&site_id=shop'],
];

describe('branch, revision and Extension tools', () => {
  for (const [name, args, method, path, body] of cases) {
    it(`${name} calls ${method} ${path.split('?')[0]}`, async () => {
      const { client, calls } = await connect();
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(method);
      expect(calls[0]!.url).toBe(`https://portal.test${path}`);
      if (body !== undefined) expect(calls[0]!.body).toEqual(body);
    });
  }

  it('classifies tools by the permission the portal requires', async () => {
    const { client } = await connect('compact');
    const effect = async (name: string) => JSON.parse((await client.callTool({ name: 'describe_tool', arguments: { name } }) as { content: Array<{ text: string }> }).content[0]!.text).effect;
    for (const name of ['diff_version', 'preview_page_revision', 'list_partial_revisions', 'read_partial_revision', 'list_developer_extensions']) expect(await effect(name)).toBe('read');
    for (const name of ['restore_partial_revision', 'launch_extension_admin_page']) expect(await effect(name)).toBe('write');
    for (const name of [
      'create_branch', 'reset_version', 'merge_branch', 'delete_branch', 'install_extension', 'set_extension_installation_status',
      'uninstall_extension', 'pair_extension_issuer', 'read_extension_diagnostics',
      'publish_extension_version',
    ]) expect(await effect(name)).toBe('admin');
  });

  it('refuses admin tools on a write share before any request', async () => {
    const { client, calls } = await connect('full', { fixedSiteId: undefined, allowedSites: [{ siteId: 'shared', permission: 'write' }] });
    const denied = await client.callTool({ name: 'reset_version', arguments: { site_id: 'shared', version_id: 'redesign' } });
    expect(denied.isError).toBe(true);
    expect(calls).toEqual([]);
    const allowed = await client.callTool({ name: 'diff_version', arguments: { site_id: 'shared', version_id: 'redesign' } });
    expect(allowed.isError).not.toBe(true);
    expect(calls[0]!.url).toBe('https://portal.test/api/v1/sites/shared/versions/redesign/diff');
  });
});
