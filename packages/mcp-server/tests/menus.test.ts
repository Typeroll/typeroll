// Menu tools: each maps onto the v1 menus routes; update_menu and
// add_menu_item keep the revision check and report validation errors plainly.

import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { menuTools } from '../src/tools/menus.js';
import { effectFor } from '../src/server.js';

interface Recorded { method: string; url: string; body: unknown }

function setup(responder: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    return responder(call);
  };
  return { client: new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb', fetchImpl }), siteId: 'mysite', calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tool = (name: string) => menuTools.find(t => t.name === name)!;
const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);
const BASE = 'https://example.test/api/v1/sites/mysite/menus';

const primary = {
  id: 'primary', name: 'Main menu', locations: ['primary'], auto_add_pages: true, updated_at: '2026-11-07T10:00:00.000Z',
  items: [{ id: 'home', type: 'page', page_id: 'home' }, { id: 'services', type: 'page', page_id: 'services', children: [{ id: 'web', type: 'page', page_id: 'web', children: [{ id: 'seo', type: 'page', page_id: 'seo' }] }] }],
};

describe('menu tools', () => {
  it('classifies reads and writes', () => {
    expect(['list_menus', 'read_menu', 'find_menu_usage'].map(effectFor)).toEqual(['read', 'read', 'read']);
    expect(['update_menu', 'add_menu_item', 'delete_menu'].map(effectFor)).toEqual(['write', 'write', 'write']);
  });

  it('lists, reads and deletes on the requested version', async () => {
    const { client, siteId, calls } = setup(() => json({ ok: true }));
    await tool('list_menus').handler({ version: 'redesign' } as never, { client, siteId });
    await tool('read_menu').handler({ menu_id: 'primary' } as never, { client, siteId });
    await tool('find_menu_usage').handler({ menu_id: 'footer' } as never, { client, siteId });
    await tool('delete_menu').handler({ menu_id: 'footer', version: 'redesign' } as never, { client, siteId });
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}?version=redesign`, `GET ${BASE}/primary`, `GET ${BASE}/footer/usage`, `DELETE ${BASE}/footer?version=redesign`,
    ]);
  });

  it('update_menu replaces with the revision check when expected_updated_at is given', async () => {
    const { client, siteId, calls } = setup(() => json({ menu: primary }));
    const result = await tool('update_menu').handler({ menu_id: 'primary', name: 'Main menu', locations: ['primary'], items: primary.items, expected_updated_at: primary.updated_at } as never, { client, siteId });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ method: 'PUT', url: `${BASE}/primary`, body: { name: 'Main menu', locations: ['primary'], items: primary.items, expected_updated_at: primary.updated_at } }]);
  });

  it('update_menu passes take_locations so a new menu can take a starter menu\'s location', async () => {
    const { client, siteId, calls } = setup(() => json({ menu: { id: 'huvudmeny' }, moved_locations: [{ location: 'primary', from_menu_id: 'primary' }] }, 201));
    const result = await tool('update_menu').handler({ name: 'Huvudmeny', locations: ['primary'], take_locations: true, items: [] } as never, { client, siteId });
    expect(text(result as never).moved_locations).toEqual([{ location: 'primary', from_menu_id: 'primary' }]);
    expect(calls).toEqual([{ method: 'POST', url: BASE, body: { name: 'Huvudmeny', locations: ['primary'], items: [], take_locations: true } }]);
    const conflict = setup(() => json({ error: 'The location "primary" is already filled by the menu "Main menu" (primary).' }, 409));
    const refused = await tool('update_menu').handler({ name: 'Huvudmeny', locations: ['primary'], items: [] } as never, { client: conflict.client, siteId });
    expect(text(refused as never).hint).toContain('take_locations: true');
  });

  it('update_menu creates a missing menu and refuses to overwrite an existing one without expected_updated_at', async () => {
    const created = setup(req => req.method === 'GET' ? json({ error: 'Menu not found' }, 404) : json({ menu: { id: 'legal' } }, 201));
    await tool('update_menu').handler({ menu_id: 'legal', name: 'Legal', items: [] } as never, { client: created.client, siteId: 'mysite' });
    expect(created.calls.map(c => c.method)).toEqual(['GET', 'POST']);
    expect(created.calls[1]).toMatchObject({ url: BASE, body: { id: 'legal', name: 'Legal', items: [] } });

    const existing = setup(() => json({ menu: primary }));
    const refused = await tool('update_menu').handler({ menu_id: 'primary', name: 'Main', items: [] } as never, { client: existing.client, siteId: 'mysite' });
    expect(refused.isError).toBe(true);
    expect(text(refused).error).toMatch(/expected_updated_at/);
    expect(existing.calls.map(c => c.method)).toEqual(['GET']);

    const derived = setup(() => json({ menu: { id: 'main-menu' } }, 201));
    await tool('update_menu').handler({ name: 'Main menu', items: [] } as never, { client: derived.client, siteId: 'mysite' });
    expect(derived.calls).toEqual([{ method: 'POST', url: BASE, body: { name: 'Main menu', items: [] } }]);
  });

  it('returns validation errors with their paths', async () => {
    const { client, siteId } = setup(() => json({ error: 'The menu is not valid: items[0].href: Give the address', details: { errors: [{ path: 'items[0].href', message: 'Give the address' }] } }, 400));
    const result = await tool('update_menu').handler({ name: 'Bad', items: [{ type: 'url', label: 'x' }] } as never, { client, siteId });
    expect(result.isError).toBe(true);
    expect(text(result).errors).toEqual([{ path: 'items[0].href', message: 'Give the address' }]);
  });

  it('add_menu_item appends under a parent with a fresh id and the read updated_at', async () => {
    const { client, siteId, calls } = setup(req => json({ menu: req.method === 'PUT' ? { ...primary, updated_at: 'later' } : primary }));
    const result = await tool('add_menu_item').handler({ menu_id: 'primary', parent_item_id: 'services', item: { type: 'url', href: 'https://shop.example.com', label: 'Home' } } as never, { client, siteId });
    expect(result.isError).toBeFalsy();
    expect(text(result).item_id).toBe('home-2');
    const put = calls[1]!;
    expect(put).toMatchObject({ method: 'PUT', url: `${BASE}/primary` });
    const body = put.body as { expected_updated_at: string; items: typeof primary.items; locations: string[]; auto_add_pages: boolean };
    expect(body.expected_updated_at).toBe(primary.updated_at);
    expect(body.locations).toEqual(['primary']);
    expect(body.auto_add_pages).toBe(true);
    expect(body.items[1]!.children!.map(c => c.id)).toEqual(['web', 'home-2']);
    // The menu as read is not changed in place.
    expect(primary.items[1]!.children).toHaveLength(1);
  });

  it('add_menu_item appends at the top level and refuses a fourth level or an unknown parent', async () => {
    const { client, siteId, calls } = setup(() => json({ menu: primary }));
    await tool('add_menu_item').handler({ menu_id: 'primary', item: { type: 'page', page_id: 'about' }, position: 1 } as never, { client, siteId });
    expect((calls[1]!.body as { items: Array<{ id: string }> }).items.map(i => i.id)).toEqual(['home', 'about', 'services']);
    const deep = await tool('add_menu_item').handler({ menu_id: 'primary', parent_item_id: 'seo', item: { type: 'page', page_id: 'x' } } as never, { client, siteId });
    expect(text(deep).error).toMatch(/3 levels/);
    const missing = await tool('add_menu_item').handler({ menu_id: 'primary', parent_item_id: 'nope', item: { type: 'page', page_id: 'x' } } as never, { client, siteId });
    expect(missing.isError).toBe(true);
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  it('add_menu_item explains a concurrent save', async () => {
    const { client, siteId } = setup(req => req.method === 'PUT' ? json({ error: 'The menu was saved by someone else after you read it.' }, 409) : json({ menu: primary }));
    const result = await tool('add_menu_item').handler({ menu_id: 'primary', item: { type: 'page', page_id: 'about' } } as never, { client, siteId });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ status: 409, hint: expect.stringMatching(/read_menu again/) });
  });
});
