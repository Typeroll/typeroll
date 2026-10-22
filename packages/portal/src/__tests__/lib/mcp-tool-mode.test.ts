import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/api-keys', () => ({ verifyApiToken: vi.fn(async () => ({ siteId: 'site', orgId: 'org' })) }));
vi.mock('../../lib/mcp-tokens', () => ({ verifyToken: vi.fn(() => null) }));
vi.mock('../../lib/api-auth', () => ({ listAllowedSites: vi.fn(async () => []) }));
import { POST } from '../../pages/api/mcp/index';
import { TyperollClient } from '@typeroll/mcp-server/client';
beforeEach(() => { vi.stubEnv('PORTAL_PUBLIC_URL', 'https://portal.test'); });
async function list(mode: string, authenticated = true, method = 'tools/list', params: Record<string, unknown> = {}) {
  return POST({ request: new Request(`https://portal.test/api/mcp?tools=${mode}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(authenticated ? { authorization: 'Bearer typeroll_live_synthetic' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }) } as never);
}
it('serves compact discovery through the actual stateless hosted route', async () => {
  const response = await list('compact'); expect(response.status).toBe(200);
  const body = await response.json(); expect(body.result.tools).toHaveLength(5);
  expect(body.result.tools.map((tool: { name: string }) => tool.name)).toContain('call_admin_tool');
  const full = await (await list('full')).json(); expect(full.result.tools.length).toBeGreaterThan(100);
});
it('keeps authentication required and rejects an invalid mode', async () => {
  expect((await list('compact', false)).status).toBe(401);
  expect((await list('invalid')).status).toBe(400);
});

it('exposes the same native presentation fields in Cloud full and compact schemas', async () => {
  const full = await (await list('full')).json();
  for (const [name, field] of [['update_site_settings', 'responsive_breakpoints'], ['update_page', 'breadcrumb_label']]) {
    const fullSchema = full.result.tools.find((tool: { name: string }) => tool.name === name).inputSchema;
    const response = await list('compact', true, 'tools/call', { name: 'describe_tool', arguments: { name } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const compactSchema = JSON.parse(body.result.content[0].text).inputSchema;
    const properties = (schema: any) => name === 'update_page' ? schema.properties.patch.properties : schema.properties;
    expect(properties(fullSchema)[field]).toBeDefined();
    expect(properties(compactSchema)[field]).toEqual(properties(fullSchema)[field]);
  }
});


it('advertises and forwards the domain cutover fields through hosted full and compact MCP', async () => {
  const full = await (await list('full')).json();
  for (const [name, field, expected] of [
    ['set_publishing_domains', 'redirect_hosts', { type: 'array', items: { type: 'string' }, maxItems: 4 }],
    ['approve_publishing_domain_cutover', 'accept_validation_window', { type: 'boolean' }],
  ] as const) {
    const schema = full.result.tools.find((tool: { name: string }) => tool.name === name).inputSchema;
    expect(schema.properties[field]).toMatchObject(expected);
    expect(schema.additionalProperties).toBe(false);
    const description = await (await list('compact', true, 'tools/call', { name: 'describe_tool', arguments: { name } })).json();
    expect(JSON.parse(description.result.content[0].text).inputSchema.properties[field]).toMatchObject(expected);
  }
  const put = vi.spyOn(TyperollClient.prototype, 'put').mockResolvedValue({ saved: true });
  const post = vi.spyOn(TyperollClient.prototype, 'post').mockResolvedValue({ accepted: true });
  try {
    const args = { revision: 'synthetic-revision', website_host: 'moveria.se', media_host: null,
      dns_mode: 'external', redirect_hosts: ['www.moveria.se'] };
    const result = await (await list('full', true, 'tools/call', { name: 'set_publishing_domains', arguments: args })).json();
    expect(result.result.isError).not.toBe(true);
    expect(put).toHaveBeenCalledWith('site', 'publishing/domains', args);
    const approval = { revision: 'synthetic-revision', candidate_id: 'synthetic-candidate', accept_validation_window: true };
    const compact = await (await list('compact', true, 'tools/call', {
      name: 'call_write_tool', arguments: { name: 'approve_publishing_domain_cutover', arguments: approval },
    })).json();
    expect(compact.result.isError).not.toBe(true);
    expect(post).toHaveBeenCalledWith('site', 'publishing/cutover', approval);
    const invalid = await (await list('full', true, 'tools/call', {
      name: 'set_publishing_domains', arguments: { ...args, redirect_hosts: Array(5).fill('www.moveria.se') },
    })).json();
    expect(invalid.result.isError).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  } finally { put.mockRestore(); post.mockRestore(); }
});
