// The Fonts library and font settings over the v1 API (API keys, as MCP
// uses it): uploads by base64 or by URL with a licence confirmation, catalog
// search across the catalog, the library and font services, deletes, and the
// settings PATCH that validates the font roles, fonts.load and fonts.services,
// refuses font_plan and warns about families nothing can load. Nothing
// reaches the network: the guarded fetch is replaced.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths, type SiteFontFile } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { testTrueTypeFont } from '../helpers/font-fixtures';

const ORG = 'ownerorg';
const READER = 'readerorg';
const SITE = 'mysite';
let adminToken = '';
let readToken = '';
const fetched: string[] = [];

async function store() { return (await import('../../lib/datastore')).getStore(); }

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  vi.stubEnv('R2_PRIVATE_BUCKET', '');
  fetched.length = 0;
  vi.doMock('../../lib/net/safe-fetch', async load => ({
    ...await load<object>(),
    createSafeFetch: () => (async (input: string | URL) => {
      fetched.push(String(input));
      if (String(input) === 'https://fonts.example.com/brand.ttf') return new Response(new Uint8Array(testTrueTypeFont({ family: 'Remote Sans', subfamily: 'Regular', weight: 400, italic: false })), { status: 200 });
      return new Response('missing', { status: 404 });
    }) as typeof fetch,
  }));
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString(), media_id: 'abc123defg' });
  await s.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString() });
  await s.setDoc(paths.settings(ORG, SITE), { site_name: 'My Site', fonts: { heading: 'Inter', body: 'Inter', size_base: 16 } });
  const { createApiKey } = await import('../../lib/api-keys');
  adminToken = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'admin', createdBy: 'admin' })).token;
  const { writeShare } = await import('../../lib/shares');
  await writeShare({ id: 'share-r', site_id: SITE, owner_org_id: ORG, shared_with_org_id: READER, permission: 'read', created_at: Date.now(), created_by: 'owner@example.com' });
  readToken = (await createApiKey({ orgId: READER, siteId: null, name: 'reader', createdBy: 'reader' })).token;
});
afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('../../lib/net/safe-fetch'); });

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function call(route: string, method: Method, rest: string, body?: unknown, token = adminToken): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/${route}`)) as Partial<Record<string, APIRoute>>;
  const fontId = /^\/fonts\/([^/?]+)/.exec(rest)?.[1];
  const request = new Request(`http://localhost/api/v1/sites/${SITE}${rest}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request, params: { siteId: SITE, ...(fontId ? { fontId } : {}) }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('v1 font library', () => {
  it('adds a font from base64 or a URL, lists, searches and deletes it', async () => {
    const created = await call('fonts/index', 'POST', '/fonts', { filename: 'brand.ttf', data_base64: b64(testTrueTypeFont({ family: 'Brand Sans' })), weight: '500', style: 'normal', licence_confirmed: true, licence_note: 'Webfont licence' });
    expect(created.status).toBe(201);
    const { font } = await created.json() as { font: SiteFontFile };
    expect(font).toMatchObject({ family: 'Brand Sans', weight: 500, style: 'normal', licence: { by: expect.stringMatching(/^api-key:/), note: 'Webfont licence' }, original: { format: 'ttf', name: 'brand.ttf' } });

    const remote = await call('fonts/index', 'POST', '/fonts', { source_url: 'https://fonts.example.com/brand.ttf', licence_confirmed: true });
    expect(remote.status).toBe(201);
    expect((await remote.json() as { font: SiteFontFile }).font).toMatchObject({ family: 'Remote Sans', weight: 400, style: 'normal', original: { name: 'brand.ttf' } });
    expect(fetched).toEqual(['https://fonts.example.com/brand.ttf']);
    const unreachable = await call('fonts/index', 'POST', '/fonts', { source_url: 'https://fonts.example.com/missing.ttf', licence_confirmed: true });
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toMatchObject({ code: 'font_source_unavailable' });

    // Settings choose the uploaded family and a service family.
    expect((await call('settings', 'PATCH', '/settings', { fonts: { heading: 'Brand Sans', services: [{ provider: 'adobe', kit: 'abc1234', families: ['brand-display'] }], display: 'brand-display' } })).status).toBe(200);
    const list = await (await call('fonts/index', 'GET', '/fonts', undefined, readToken)).json() as { fonts: SiteFontFile[]; used_by: Record<string, string[]> };
    expect(list.fonts).toHaveLength(2);
    expect(list.used_by).toEqual({ 'Brand Sans': ['heading'], 'Remote Sans': [] });

    const search = await (await call('fonts/catalog', 'GET', '/fonts/catalog?query=bra&limit=5', undefined, readToken)).json() as { fonts: Array<{ family: string; source: string }>; library: unknown[]; services: unknown[] };
    expect(search.library).toEqual([{ family: 'Brand Sans', source: 'upload', weights: [500], italic: false }]);
    expect(search.services).toEqual([{ family: 'brand-display', source: 'service', provider: 'adobe' }]);
    expect(search.fonts.every(entry => entry.source === 'google')).toBe(true);
    const serif = await (await call('fonts/catalog', 'GET', '/fonts/catalog?category=serif&variable=true&limit=3')).json() as { fonts: Array<{ category: string; variable?: unknown }> };
    expect(serif.fonts).toHaveLength(3);
    expect(serif.fonts.every(entry => entry.category === 'serif' && entry.variable)).toBe(true);
    expect((await call('fonts/catalog', 'GET', '/fonts/catalog?category=comic')).status).toBe(400);

    expect((await call('fonts/[fontId]', 'GET', `/fonts/${font.id}`, undefined, readToken)).status).toBe(200);
    expect((await call('fonts/[fontId]', 'DELETE', `/fonts/${font.id}`, undefined, readToken)).status).toBe(403);
    const deleted = await call('fonts/[fontId]', 'DELETE', `/fonts/${font.id}`);
    expect(await deleted.json()).toMatchObject({ deleted: true, warning: expect.stringContaining('heading') });
  });

  it('refuses uploads without admin, a licence confirmation or exactly one source', async () => {
    const data_base64 = b64(testTrueTypeFont());
    expect((await call('fonts/index', 'POST', '/fonts', { filename: 'a.ttf', data_base64, licence_confirmed: true }, readToken)).status).toBe(403);
    expect(await (await call('fonts/index', 'POST', '/fonts', { filename: 'a.ttf', data_base64 })).json()).toMatchObject({ code: 'font_licence_required' });
    expect(await (await call('fonts/index', 'POST', '/fonts', { filename: 'a.ttf', data_base64, licence_confirmed: 'yes' })).json()).toMatchObject({ code: 'font_licence_required' });
    expect(await (await call('fonts/index', 'POST', '/fonts', { source_url: 'https://fonts.example.com/brand.ttf' })).json()).toMatchObject({ code: 'font_licence_required' });
    expect(fetched).toEqual([]);
    expect((await call('fonts/index', 'POST', '/fonts', { filename: 'a.ttf', licence_confirmed: true })).status).toBe(400);
    expect((await call('fonts/index', 'POST', '/fonts', { data_base64, source_url: 'https://fonts.example.com/brand.ttf', licence_confirmed: true })).status).toBe(400);
    expect((await call('fonts/index', 'POST', '/fonts', { data_base64, licence_confirmed: true, colour: 'red' })).status).toBe(400);
    expect(await (await call('fonts/index', 'POST', '/fonts', { source_url: 'http://fonts.example.com/brand.ttf', licence_confirmed: true })).json()).toMatchObject({ code: 'font_details_invalid' });
  });
});

describe('font settings', () => {
  it('validates roles, fonts.load and fonts.services, clears with null and refuses font_plan', async () => {
    const plan = await call('settings', 'PATCH', '/settings', { font_plan: { families: [] } });
    expect(plan.status).toBe(400);
    expect((await plan.json() as { error: string }).error).toContain('font_plan');
    const badLoad = await call('settings', 'PATCH', '/settings', { fonts: { load: { heading: { weights: [450] } } } });
    expect(badLoad.status).toBe(400);
    expect(await badLoad.json()).toMatchObject({ details: { errors: [expect.stringContaining('fonts.load.heading.weights')] } });
    expect((await call('settings', 'PATCH', '/settings', { fonts: { services: [{ provider: 'bunny', url: 'https://evil.example/css', families: ['X'] }] } })).status).toBe(400);
    expect((await call('settings', 'PATCH', '/settings', { fonts: { heading: null } })).status).toBe(400);
    expect((await call('settings', 'PATCH', '/settings', { fonts: { display: '<b>' } })).status).toBe(400);

    const saved = await call('settings', 'PATCH', '/settings', { fonts: { display: 'Fraunces', accent: 'Unknown Brand Face', load: { body: { weights: [300], italic: [400] } } } });
    expect(saved.status).toBe(200);
    const body = await saved.json() as { warnings?: string[] };
    expect(body.warnings).toEqual([expect.stringContaining('fonts.accent "Unknown Brand Face"')]);
    const settings = await (await store()).getDoc<{ fonts: Record<string, unknown> }>(paths.settings(ORG, SITE));
    expect(settings!.fonts).toMatchObject({ heading: 'Inter', display: 'Fraunces', accent: 'Unknown Brand Face', load: { body: { weights: [300], italic: [400] } } });

    await call('settings', 'PATCH', '/settings', { fonts: { display: null, accent: null, load: null } });
    const cleared = await (await store()).getDoc<{ fonts: Record<string, unknown> }>(paths.settings(ORG, SITE));
    expect(Object.keys(cleared!.fonts).sort()).toEqual(['body', 'heading', 'size_base']);
  });
});
