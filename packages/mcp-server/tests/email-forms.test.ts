import { describe, expect, it, vi } from 'vitest';
import { emailTools } from '../src/tools/email.js';
import { formTools } from '../src/tools/forms.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { TyperollClient } from '../src/client.js';

function client() {
  return {
    get: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({ ok: true }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    del: vi.fn().mockResolvedValue({ ok: true }),
  };
}
const tool = (list: typeof emailTools, name: string) => list.find((t) => t.name === name)!;

describe('email settings tools', () => {
  it('call the v1 email connector routes', async () => {
    const c = client();
    const deps = { client: c as never, siteId: 'site-a' };
    await tool(emailTools, 'get_email_settings').handler({}, deps);
    expect(c.get).toHaveBeenCalledWith('site-a', 'integrations/email');

    await tool(emailTools, 'set_email_settings').handler({ type: 'postmark', from: 'Acme <hi@acme.com>', config: { server_token: 't' } }, deps);
    expect(c.put).toHaveBeenCalledWith('site-a', 'integrations/email', { type: 'postmark', from: 'Acme <hi@acme.com>', config: { server_token: 't' } });

    await tool(emailTools, 'set_email_settings').handler({ type: 'smtp', from: 'a@b.com', reply_to: 'r@b.com' }, deps);
    expect(c.put).toHaveBeenLastCalledWith('site-a', 'integrations/email', { type: 'smtp', from: 'a@b.com', reply_to: 'r@b.com', config: {} });

    await tool(emailTools, 'delete_email_settings').handler({}, deps);
    expect(c.del).toHaveBeenCalledWith('site-a', 'integrations/email');

    await tool(emailTools, 'send_test_email').handler({ to: 'me@example.com' }, deps);
    expect(c.post).toHaveBeenCalledWith('site-a', 'integrations/email/test', { to: 'me@example.com' });
  });

  it('call the v1 incoming email routes', async () => {
    const c = client();
    const deps = { client: c as never, siteId: 'site-a' };
    await tool(emailTools, 'get_incoming_email_settings').handler({}, deps);
    expect(c.get).toHaveBeenCalledWith('site-a', 'delivery/inbound');
    await tool(emailTools, 'set_incoming_email_forwarding').handler({ route_id: 'replies', revision: 'r1', enabled: true }, deps);
    expect(c.put).toHaveBeenCalledWith('site-a', 'delivery/inbound', { route_id: 'replies', revision: 'r1', enabled: true });
    const receipt = 'a'.repeat(64);
    await tool(emailTools, 'read_incoming_email_receipt').handler({ receipt_id: receipt }, deps);
    expect(c.get).toHaveBeenLastCalledWith('site-a', `delivery/inbound/${receipt}`);
  });
});

describe('form discovery and submission tools', () => {
  it('read capabilities and one submission through the v1 API', async () => {
    const c = client();
    const deps = { client: c as never, siteId: 'site-a' };
    await tool(formTools, 'get_form_capabilities').handler({}, deps);
    expect(c.get).toHaveBeenCalledWith('site-a', 'form-capabilities');
    await tool(formTools, 'read_form_submission').handler({ form_id: 'contact', submission_id: 'a/b' }, deps);
    expect(c.get).toHaveBeenLastCalledWith('site-a', 'forms/contact/submissions/a%2Fb');
  });
});

describe('registration', () => {
  it('registers the new tools, with admin effect for email changes', async () => {
    const api = new TyperollClient({ baseUrl: 'https://portal.test', apiKey: 'synthetic', fetchImpl: async () => Response.json({}) });
    const server = buildServer({ client: api, fixedSiteId: 'site', toolMode: 'compact' });
    const mcp = new Client({ name: 'email-forms-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await mcp.connect(b);
    try {
      for (const [name, effect] of [
        ['set_email_settings', 'admin'], ['delete_email_settings', 'admin'], ['send_test_email', 'admin'],
        ['set_incoming_email_forwarding', 'admin'], ['get_email_settings', 'read'], ['get_incoming_email_settings', 'read'],
        ['read_incoming_email_receipt', 'read'], ['get_form_capabilities', 'read'], ['read_form_submission', 'read'],
      ] as const) {
        const result = await mcp.callTool({ name: 'describe_tool', arguments: { name } }) as { content: Array<{ text: string }> };
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ name, effect });
      }
    } finally {
      await mcp.close();
    }
  });
});
