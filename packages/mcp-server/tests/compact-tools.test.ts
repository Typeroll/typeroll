import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type BuildServerOptions } from '../src/server.js';
import { TyperollClient } from '../src/client.js';

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(client => client.close())); });
async function connect(toolMode: 'compact' | 'full', overrides: Partial<BuildServerOptions> = {}) {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const api = new TyperollClient({ baseUrl: 'https://portal.test', apiKey: 'synthetic', fetchImpl: async (url, init) => { calls.push({ url: String(url), method: init?.method, body: init?.body as string }); return Response.json({ sites: [{ id: 'site', name: 'Site' }], id: 'site' }); } });
  const server = buildServer({ client: api, fixedSiteId: 'site', toolMode, ...overrides });
  const client = new Client({ name: 'workspace-qa', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); connections.push(client);
  return { client, calls };
}
const payload = (result: any) => JSON.parse(result.content[0].text);
it('bounds initial tools/list context independently of the catalog size', async () => {
  const compact = await connect('compact'), full = await connect('full');
  const small = await compact.client.listTools(), large = await full.client.listTools();
  expect(small.tools.map(tool => tool.name)).toEqual(['search_tools', 'describe_tool', 'call_read_tool', 'call_write_tool', 'call_admin_tool']);
  expect(large.tools.length).toBeGreaterThan(100);
  expect(JSON.stringify(small).length).toBeLessThan(JSON.stringify(large).length * 0.1);
  expect(small.tools.find(tool => tool.name === 'call_read_tool')?.annotations?.readOnlyHint).toBe(true);
  expect(small.tools.find(tool => tool.name === 'call_write_tool')?.annotations?.readOnlyHint).toBe(false);
  console.log(JSON.stringify({ compact_schema_bytes: Buffer.byteLength(JSON.stringify(small)), full_schema_bytes: Buffer.byteLength(JSON.stringify(large)), full_tools: large.tools.length }));
});
it('discovers exact schemas and executes the same underlying read without mutations', async () => {
  const { client, calls } = await connect('compact');
  const found = payload(await client.callTool({ name: 'search_tools', arguments: { query: 'read_page', limit: 2 } }));
  expect(found.tools[0].name).toBe('read_page'); expect(found.tools.length).toBeLessThanOrEqual(2);
  const described = payload(await client.callTool({ name: 'describe_tool', arguments: { name: 'read_page' } }));
  expect(described.inputSchema.properties.page_id).toBeDefined();
  await client.callTool({ name: 'call_read_tool', arguments: { name: 'read_page', arguments: { page_id: 'home', version: 'branch' } } });
  expect(calls[0].url).toContain('/pages/home?version=branch'); expect(calls[0].method).toBe('GET');
});
it('rejects malformed arguments, unknown names and using a read endpoint to publish', async () => {
  const { client, calls } = await connect('compact');
  for (const [name, args] of [['call_read_tool', { name: 'trigger_deploy' }], ['call_read_tool', { name: 'read_page', arguments: {} }], ['call_write_tool', { name: '__proto__' }], ['call_write_tool', { name: 'activate_extension_release' }]] as const) {
    expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
  }
  expect(calls).toEqual([]);
});
it('preserves shared-site permission and inaccessible-site guards through generic calls', async () => {
  const { client, calls } = await connect('compact', { fixedSiteId: undefined, allowedSites: [{ siteId: 'readable', permission: 'read' }] });
  const denied = await client.callTool({ name: 'call_write_tool', arguments: { name: 'trigger_deploy', arguments: { site_id: 'readable' } } });
  expect(denied.isError).toBe(true);
  const outside = await client.callTool({ name: 'call_read_tool', arguments: { name: 'get_site', arguments: { site_id: 'other' } } });
  expect(outside.isError).toBe(true); expect(calls).toEqual([]);
  await client.callTool({ name: 'call_read_tool', arguments: { name: 'get_site', arguments: { site_id: 'readable' } } });
  expect(calls[0].url).toContain('/readable/');
});
it('discovers sites and guide sections without loading the full manual', async () => {
  const { client } = await connect('compact', { fixedSiteId: undefined, allowedSites: [] });
  const sites = payload(await client.callTool({ name: 'call_read_tool', arguments: { name: 'list_sites', arguments: {} } }));
  expect(sites.sites[0].id).toBe('site');
  const index = payload(await client.callTool({ name: 'call_read_tool', arguments: { name: 'read_guide', arguments: { sections_only: true } } }));
  expect(index.sections.length).toBeGreaterThan(3);
  const section: any = await client.callTool({ name: 'call_read_tool', arguments: { name: 'read_guide', arguments: { section: index.sections[1].id } } });
  expect(section.content[0].text).toContain(index.sections[1].title);
  expect(section.content[0].text.length).toBeLessThan(20000);
});

it('discovers native presentation controls by the terms used in the portal', async () => {
  const { client } = await connect('compact');
  for (const [query, expected] of [['breakpoints', 'update_site_settings'], ['breadcrumb', 'update_page']]) {
    const found = payload(await client.callTool({ name: 'search_tools', arguments: { query, limit: 12 } }));
    expect(found.tools.map((tool: { name: string }) => tool.name)).toContain(expected);
  }
});

for (const mode of ['compact', 'full'] as const) it(`preserves presentation fields and branch scope through ${mode} MCP`, async () => {
  const { client, calls } = await connect(mode);
  const schema = async (name: string) => mode === 'compact'
    ? payload(await client.callTool({ name: 'describe_tool', arguments: { name } })).inputSchema
    : (await client.listTools()).tools.find(tool => tool.name === name)!.inputSchema;
  expect((await schema('update_site_settings')).properties.responsive_breakpoints).toBeDefined();
  expect((await schema('update_page')).properties.patch.properties.breadcrumb_label).toBeDefined();
  const call = (name: string, args: Record<string, unknown>) => client.callTool(mode === 'compact'
    ? { name: 'call_write_tool', arguments: { name, arguments: args } }
    : { name, arguments: args });
  const widths = { tablet: 576, laptop: 769, desktop: 1024, wide: 1280 };
  expect((await call('update_site_settings', { responsive_breakpoints: widths, version: 'redesign' })).isError).not.toBe(true);
  expect(calls[0].url).toContain('/settings?version=redesign');
  expect(JSON.parse(calls[0].body!)).toEqual({ responsive_breakpoints: widths });
  expect((await call('update_page', { page_id: 'tips', patch: { breadcrumb_label: 'Moving tips' }, save: true, version: 'redesign' })).isError).not.toBe(true);
  expect(calls[1].url).toContain('/pages/tips?version=redesign');
  expect(JSON.parse(calls[1].body!)).toEqual({ breadcrumb_label: 'Moving tips', save: true });
  await call('update_site_settings', { responsive_breakpoints: null });
  expect(JSON.parse(calls[2].body!)).toEqual({ responsive_breakpoints: null });
});
