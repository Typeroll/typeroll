// Site field tools: each maps onto /api/v1/sites/{siteId}/site-fields;
// define_site_fields is admin, and refused saves report their paths plainly.

import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { siteFieldTools } from '../src/tools/site-fields.js';
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
const tool = (name: string) => siteFieldTools.find(t => t.name === name)!;
const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);
const URL_ = 'https://example.test/api/v1/sites/mysite/site-fields';

describe('site field tools', () => {
  it('classifies reading, values and definitions', () => {
    expect(['read_site_fields', 'update_site_fields', 'define_site_fields'].map(effectFor)).toEqual(['read', 'write', 'admin']);
  });

  it('reads, defines and updates on the requested version with the revision check', async () => {
    const { client, siteId, calls } = setup(() => json({ groups: [], values: {}, updated_at: 'T2' }));
    await tool('read_site_fields').handler({ version: 'redesign' } as never, { client, siteId });
    const groups = [{ id: 'booking', label: 'Booking', fields: [{ name: 'show_booking', type: 'boolean', label: 'Show the booking calendar' }] }];
    await tool('define_site_fields').handler({ groups, expected_updated_at: null } as never, { client, siteId });
    await tool('update_site_fields').handler({ values: { show_booking: true, old: null }, expected_updated_at: 'T1', version: 'redesign' } as never, { client, siteId });
    expect(calls).toEqual([
      { method: 'GET', url: `${URL_}?version=redesign`, body: null },
      { method: 'PUT', url: URL_, body: { groups, expected_updated_at: null } },
      { method: 'PATCH', url: `${URL_}?version=redesign`, body: { values: { show_booking: true, old: null }, expected_updated_at: 'T1' } },
    ]);
  });

  it('reports validation errors with their paths and explains a conflict', async () => {
    const invalid = setup(() => json({ error: 'The values are not valid', errors: [{ path: 'delivery_days', message: 'A number expected' }] }, 400));
    const out = await tool('update_site_fields').handler({ values: { delivery_days: 'soon' } } as never, { client: invalid.client, siteId: 'mysite' });
    expect(out.isError).toBe(true);
    expect(text(out as never)).toMatchObject({ status: 400, errors: [{ path: 'delivery_days' }] });

    const stale = setup(() => json({ error: 'The site fields were saved by someone else' }, 409));
    const conflict = await tool('define_site_fields').handler({ groups: [], expected_updated_at: 'old' } as never, { client: stale.client, siteId: 'mysite' });
    expect(text(conflict as never)).toMatchObject({ status: 409 });
    expect(text(conflict as never).hint).toContain('read_site_fields');
  });

  it('teaches opening hours, template use and the blocks', () => {
    const description = tool('read_site_fields').description;
    for (const needle of ['presentation', 'opening_hours', '{{site.fields.name}}', 'core/site_field', 'next_opening', 'open_now', 'core/show_if', 'site.fields.show_booking', 'access'])
      expect(description).toContain(needle);
  });
});
