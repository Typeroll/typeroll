// Collection and member tools map onto /api/v1/sites/{siteId}/collection/* and
// /api/v1/organization/members/*; a builder's personal connection runs the
// design tools that are otherwise admin.

import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { collectionTools } from '../src/tools/collection.js';
import { accessTools } from '../src/tools/access.js';
import { effectFor, toolAllowed } from '../src/server.js';

interface Recorded { method: string; url: string; body: unknown }
function setup() {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb', fetchImpl }), siteId: 'mysite', calls };
}
const tool = (name: string) => [...collectionTools, ...accessTools].find(t => t.name === name)!;
const BASE = 'https://example.test/api/v1/sites/mysite/collection';

describe('collection tools', () => {
  it('maps onto the collection routes', async () => {
    const { client, siteId, calls } = setup();
    await tool('list_collection_entries').handler({} as never, { client, siteId });
    await tool('save_to_collection').handler({ kind: 'section', id: 'hero', category: 'Heroes' } as never, { client, siteId });
    await tool('add_package_to_collection').handler({ data_base64: 'UEsDBA==' } as never, { client, siteId });
    await tool('insert_from_collection').handler({ entry_id: 'hero-1a2b3c4d', target: 'page', page_id: 'home', after_block_id: 'b1', version: 'redesign' } as never, { client, siteId });
    await tool('update_collection_entry').handler({ entry_id: 'hero-1a2b3c4d', name: 'Hero' } as never, { client, siteId });
    await tool('delete_collection_entry').handler({ entry_id: 'hero-1a2b3c4d' } as never, { client, siteId });
    expect(calls).toEqual([
      { method: 'GET', url: BASE, body: null },
      { method: 'POST', url: `${BASE}/save`, body: { kind: 'section', id: 'hero', category: 'Heroes' } },
      { method: 'POST', url: `${BASE}/import`, body: { data_base64: 'UEsDBA==' } },
      { method: 'POST', url: `${BASE}/hero-1a2b3c4d/insert?version=redesign`, body: { target: 'page', page_id: 'home', after_block_id: 'b1' } },
      { method: 'PATCH', url: `${BASE}/hero-1a2b3c4d`, body: { name: 'Hero' } },
      { method: 'DELETE', url: `${BASE}/hero-1a2b3c4d`, body: null },
    ]);
    expect(tool('insert_from_collection').description).toContain('never mapped');
  });

  it('maps member tools and classifies them', async () => {
    const { client, calls } = setup();
    await tool('list_organization_members').handler({} as never, { client, siteId: '' });
    await tool('update_organization_member_role').handler({ member_id: 'u1', role: 'builder' } as never, { client, siteId: '' });
    await tool('remove_organization_member').handler({ member_id: 'u1' } as never, { client, siteId: '' });
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET https://example.test/api/v1/organization/members',
      'PATCH https://example.test/api/v1/organization/members/u1',
      'DELETE https://example.test/api/v1/organization/members/u1',
    ]);
    expect(calls[1]!.body).toEqual({ role: 'builder' });
    expect(['list_organization_members', 'update_organization_member_role', 'remove_organization_member', 'list_collection_entries', 'insert_from_collection'].map(effectFor))
      .toEqual(['read', 'admin', 'admin', 'read', 'write']);
  });

  it('lets a builder run the design tools, and nothing else that needs admin', () => {
    expect(toolAllowed('update_site_settings', 'admin', 'write', true)).toBe(true);
    expect(toolAllowed('define_site_fields', 'admin', 'write', true)).toBe(true);
    expect(toolAllowed('update_site_settings', 'admin', 'write', false)).toBe(false);
    expect(toolAllowed('share_site', 'admin', 'write', true)).toBe(false);
    expect(toolAllowed('trigger_deploy', effectFor('trigger_deploy'), 'write', true)).toBe(PERM_OK(effectFor('trigger_deploy')));
    expect(toolAllowed('update_site_settings', 'admin', 'read', true)).toBe(false);
  });
});

const PERM_OK = (effect: string) => effect !== 'admin';
