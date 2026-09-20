import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/api-keys', () => ({ verifyApiToken: vi.fn(async () => ({ siteId: 'site', orgId: 'org' })) }));
vi.mock('../../lib/mcp-tokens', () => ({ verifyToken: vi.fn(() => null) }));
vi.mock('../../lib/api-auth', () => ({ listAllowedSites: vi.fn(async () => []) }));
import { POST } from '../../pages/api/mcp/index';
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
