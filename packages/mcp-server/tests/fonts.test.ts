// Font tools: search_fonts reads /fonts/catalog, set_site_fonts patches
// settings.fonts with the version parameter, upload_font posts the file with
// its licence confirmation. All are classified like the settings they change.

import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { fontTools } from '../src/tools/fonts.js';
import { effectFor } from '../src/server.js';

interface Recorded { method: string; url: string; body: unknown }

function setup(responder: (req: Recorded) => Response = () => json({ ok: true })) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    return responder(call);
  };
  return { client: new TyperollClient({ baseUrl: 'https://example.test', apiKey: 'typeroll_live_aaaa_bbbb', fetchImpl }), siteId: 'mysite', calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tool = (name: string) => fontTools.find(t => t.name === name)!;
const BASE = 'https://example.test/api/v1/sites/mysite';

describe('font tools', () => {
  it('classifies search as read and font changes as admin, like settings', () => {
    expect(['search_fonts', 'set_site_fonts', 'upload_font'].map(effectFor)).toEqual(['read', 'admin', 'admin']);
  });

  it('searches the catalog with filters as query parameters', async () => {
    const { client, siteId, calls } = setup();
    await tool('search_fonts').handler({ query: 'grotesk', category: ['sans', 'display'], variable: true, latin_ext: false, limit: 5 } as never, { client, siteId });
    await tool('search_fonts').handler({} as never, { client, siteId });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/sites/mysite/fonts/catalog');
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'grotesk', category: 'sans,display', variable: 'true', latin_ext: 'false', limit: '5' });
    expect(calls[1]!.url).toBe(`${BASE}/fonts/catalog`);
  });

  it('patches only the font keys given, on the chosen version, and clears with null', async () => {
    const { client, siteId, calls } = setup();
    await tool('set_site_fonts').handler({ version: 'redesign', heading: 'Fraunces', display: null, load: { body: { weights: [300] } } } as never, { client, siteId });
    await tool('set_site_fonts').handler({ accent: 'brand-sans', services: [{ provider: 'adobe', kit: 'abc1234', families: ['brand-sans'] }] } as never, { client, siteId });
    expect(calls).toEqual([
      { method: 'PATCH', url: `${BASE}/settings?version=redesign`, body: { fonts: { heading: 'Fraunces', display: null, load: { body: { weights: [300] } } } } },
      { method: 'PATCH', url: `${BASE}/settings`, body: { fonts: { accent: 'brand-sans', services: [{ provider: 'adobe', kit: 'abc1234', families: ['brand-sans'] }] } } },
    ]);
    const empty = await tool('set_site_fonts').handler({ version: 'redesign' } as never, { client, siteId });
    expect(empty.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('uploads a file with its licence confirmation and reports refusals', async () => {
    const { client, siteId, calls } = setup();
    await tool('upload_font').handler({ filename: 'Brand.woff2', data_base64: 'd09GMg==', family: 'Brand Sans', weight: '100-900', licence_confirmed: true, licence_note: 'Web licence' } as never, { client, siteId });
    expect(calls).toEqual([{ method: 'POST', url: `${BASE}/fonts`, body: { filename: 'Brand.woff2', data_base64: 'd09GMg==', family: 'Brand Sans', weight: '100-900', licence_confirmed: true, licence_note: 'Web licence' } }]);
    const refused = setup(() => json({ error: 'This file is already in the Fonts library', code: 'font_duplicate' }, 409));
    const out = await tool('upload_font').handler({ source_url: 'https://fonts.example.com/a.ttf', licence_confirmed: true } as never, { client: refused.client, siteId });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain('font_duplicate');
  });

  it('teaches roles, weights in use and the licence', () => {
    const set = tool('set_site_fonts').description, upload = tool('upload_font').description;
    for (const needle of ['display', 'accent', 'choose a role, never a family', 'render version 15', 'load', 'Adobe']) expect(set).toContain(needle);
    for (const needle of ['licence', 'WOFF2', 'Adobe Fonts cannot be uploaded']) expect(upload).toContain(needle);
  });
});
