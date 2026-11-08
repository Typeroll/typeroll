// Package tools: export_package, inspect_package and import_package map onto
// /api/v1/sites/{siteId}/packages/*, pass the version, and teach that styles
// are created rather than mapped and that fonts need a licence confirmation.

import { describe, expect, it } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { packageTools } from '../src/tools/packages.js';
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
const tool = (name: string) => packageTools.find(t => t.name === name)!;
const BASE = 'https://example.test/api/v1/sites/mysite/packages';

describe('package tools', () => {
  it('classifies inspecting as read and exporting and importing as write', () => {
    expect(['export_package', 'inspect_package', 'import_package'].map(effectFor)).toEqual(['write', 'read', 'write']);
  });

  it('posts the selection and meta, and the package with its options', async () => {
    const { client, siteId, calls } = setup();
    const selection = { kind: 'collection', block_templates: ['hero'], styles: 'used', demo_media: ['m1'] };
    const meta = { id: 'acme', name: 'Acme', version: '1.0.0', author: 'Acme Studio' };
    await tool('export_package').handler({ selection, meta, version: 'redesign' } as never, { client, siteId });
    await tool('inspect_package').handler({ source_url: 'https://example.com/acme.typeroll', options: { design: 'full' } } as never, { client, siteId });
    await tool('import_package').handler({ data_base64: 'UEsDBA==', options: { design: 'content', font_licence_confirmed: true } } as never, { client, siteId });
    expect(calls).toEqual([
      { method: 'POST', url: `${BASE}/export?version=redesign`, body: { selection, meta } },
      { method: 'POST', url: `${BASE}/inspect`, body: { source_url: 'https://example.com/acme.typeroll', options: { design: 'full' } } },
      { method: 'POST', url: `${BASE}/import`, body: { data_base64: 'UEsDBA==', options: { design: 'content', font_licence_confirmed: true } } },
    ]);
  });

  it('reports refusals with their code', async () => {
    const refused = setup(() => json({ error: 'Confirm the font licence', code: 'font_licence_required' }, 400));
    const out = await tool('import_package').handler({ data_base64: 'UEsDBA==', options: { design: 'full' } } as never, { client: refused.client, siteId: 'mysite' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain('font_licence_required');
  });

  it('teaches that styles are created, not mapped, and how fonts and licences travel', () => {
    const inspect = tool('inspect_package').description, exported = tool('export_package').description;
    for (const needle of ['never mapped', 'Hero (imported)', 'font_licence_confirmed', 'Adobe', 'full']) expect(inspect).toContain(needle);
    for (const needle of ['redistributable_confirmed', 'typeroll-media', 'one hour', 'admin']) expect(exported).toContain(needle);
  });
});
