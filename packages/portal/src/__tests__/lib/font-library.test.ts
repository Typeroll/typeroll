// The site's Fonts library through the portal's session routes: uploads are
// read and converted to WOFF2 with the original kept, details default from
// the file, a licence confirmation is required and recorded, duplicates,
// collections, non-fonts and a full library are refused, and the bytes live
// in private storage (the datastore here; R2 in the storage tests). Nothing
// reaches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { MAIN_VERSION_ID, MAX_SITE_FONT_FILES, paths, readFontFile, type SiteFontFile } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { testTrueTypeFont, variableWoff2Font } from '../helpers/font-fixtures';
import { FONT_CODECS } from '../../lib/fonts/codecs';

const OWNER = 'ownerorg';
const VIEWER = 'partnerorg';
const SITE = 'mysite';
let permission: 'read' | 'write' | 'admin' = 'admin';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function store() { return (await import('../../lib/datastore')).getStore(); }

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  vi.stubEnv('R2_PRIVATE_BUCKET', '');
  permission = 'admin';
  const s = await store();
  await s.setDoc(paths.site(OWNER, SITE), { name: 'My Site', created_at: '', media_id: 'abc123defg' });
  await s.setDoc(paths.settings(OWNER, SITE, MAIN_VERSION_ID), { site_name: 'My Site', fonts: { heading: 'Test Sans', body: 'Inter', size_base: 16 } });
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: VIEWER, userId: 'u1', email: 'admin@example.com' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: MAIN_VERSION_ID, owner_org_id: OWNER, permission,
        },
      })),
    };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock('../../lib/access'); vi.doUnmock('../../lib/net/safe-fetch'); });

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function call(route: string, method: Method, rest: string, body?: FormData | Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/sites/[siteId]/fonts/${route}`)) as Partial<Record<string, APIRoute>>;
  const fontId = /^\/([^/]+)/.exec(rest)?.[1];
  const request = new Request(`http://localhost/api/sites/${SITE}/fonts${rest}`, {
    method, headers: body instanceof FormData ? headers : { 'content-type': 'application/json', ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request, params: { siteId: SITE, ...(fontId ? { fontId } : {}) }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

function upload(bytes: Uint8Array, fields: Record<string, string> = { licence_confirmed: 'true' }, name = 'TestSans-SemiboldItalic.ttf'): FormData {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe('font uploads', () => {
  it('converts a TrueType upload to WOFF2, keeps the original and records the licence', async () => {
    const ttf = testTrueTypeFont();
    const response = await call('index', 'POST', '', upload(ttf, { licence_confirmed: 'true', licence_note: 'Web licence, order 42' }));
    expect(response.status).toBe(201);
    const { font } = await response.json() as { font: SiteFontFile };
    expect(font).toMatchObject({
      family: 'Test Sans', weight: 600, style: 'italic', category: 'sans',
      file: { format: 'woff2', key: expect.stringMatching(/^private\/media\/abc123defg\/fonts\/[a-f0-9]{64}\.woff2$/) },
      original: { format: 'ttf', bytes: ttf.byteLength, sha256: sha(ttf), key: `private/media/abc123defg/fonts/originals/${sha(ttf)}.ttf`, name: 'TestSans-SemiboldItalic.ttf' },
      licence: { confirmed: true, by: 'admin@example.com', note: 'Web licence, order 42' },
      metrics: { units_per_em: 1000, ascent: 800 },
    });
    expect(font).not.toHaveProperty('storage');
    // Stored in the owner's tree, never the viewer's.
    expect(await (await store()).getDoc(paths.font(OWNER, SITE, font.id))).toMatchObject({ storage: { provider: 'datastore' } });
    expect(await (await store()).getDoc(paths.font(VIEWER, SITE, font.id))).toBeNull();

    const { readSiteFontBytes, listSiteFonts } = await import('../../lib/fonts/font-library');
    const [listed] = await listSiteFonts(OWNER, SITE);
    const woff2 = await readSiteFontBytes(OWNER, SITE, listed!);
    expect(readFontFile(woff2, FONT_CODECS)).toMatchObject({ format: 'woff2', family: 'Test Sans', weight: 600 });
    expect(Buffer.from(await readSiteFontBytes(OWNER, SITE, listed!, 'original')).equals(Buffer.from(ttf))).toBe(true);
  });

  it('lets the uploader correct the family, weight, style and category', async () => {
    const response = await call('index', 'POST', '', upload(testTrueTypeFont(), { licence_confirmed: 'true', family: 'Brand Serif', weight: '700', style: 'normal' }));
    expect((await response.json() as { font: SiteFontFile }).font).toMatchObject({ family: 'Brand Serif', weight: 700, style: 'normal', category: 'serif' });
    const sans = await call('index', 'POST', '', upload(testTrueTypeFont({ family: 'Other' }), { licence_confirmed: 'true', category: 'sans', family: 'Brand Serif Text' }));
    expect((await sans.json() as { font: SiteFontFile }).font.category).toBe('sans');
  });

  it('reads a variable WOFF2 as its weight range and keeps it as uploaded', async () => {
    const woff2 = variableWoff2Font();
    const font = (await (await call('index', 'POST', '', upload(woff2, undefined, 'fraunces.woff2'))).json() as { font: SiteFontFile }).font;
    expect(font).toMatchObject({ family: 'Fraunces', weight: [100, 900], style: 'normal', file: { sha256: sha(woff2), bytes: woff2.byteLength } });
    expect(font.original).toBeUndefined();
    const narrowed = await call('[fontId]', 'PATCH', `/${font.id}`, { weight: '300-800' });
    expect((await narrowed.json() as { font: SiteFontFile }).font.weight).toEqual([300, 800]);
    const single = await call('[fontId]', 'PATCH', `/${font.id}`, { weight: 400 });
    expect((await single.json() as { font: SiteFontFile }).font.weight).toBe(400);
    expect((await call('[fontId]', 'PATCH', `/${font.id}`, { weight: '50-900' })).status).toBe(400);
  });

  it('refuses what is not a usable font, a missing licence, duplicates and a full library', async () => {
    const ttf = testTrueTypeFont();
    const noLicence = await call('index', 'POST', '', upload(ttf, {}));
    expect(noLicence.status).toBe(400);
    expect(await noLicence.json()).toMatchObject({ code: 'font_licence_required' });

    const svg = await call('index', 'POST', '', upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), undefined, 'logo.svg'));
    expect(svg.status).toBe(415);
    expect(await svg.json()).toMatchObject({ code: 'font_unsupported' });
    const collection = new Uint8Array(64); collection.set([0x74, 0x74, 0x63, 0x66]);
    expect(await (await call('index', 'POST', '', upload(collection, undefined, 'fonts.ttc'))).json()).toMatchObject({ code: 'font_collection' });
    const truncated = await call('index', 'POST', '', upload(ttf.subarray(0, 60)));
    expect(await truncated.json()).toMatchObject({ code: 'font_invalid' });
    const tooLarge = new FormData(); tooLarge.set('file', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.ttf')); tooLarge.set('licence_confirmed', 'true');
    const huge = await call('index', 'POST', '', tooLarge);
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: 'font_too_large' });
    expect(await (await call('index', 'POST', '', upload(ttf, { licence_confirmed: 'true', weight: '100-900' }))).json()).toMatchObject({ code: 'font_details_invalid' });
    expect(await (await call('index', 'POST', '', upload(ttf, { licence_confirmed: 'true', family: '<script>' }))).json()).toMatchObject({ code: 'font_details_invalid' });

    expect((await call('index', 'POST', '', upload(ttf))).status).toBe(201);
    const duplicate = await call('index', 'POST', '', upload(ttf));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'font_duplicate' });

    const s = await store();
    for (let i = 1; i < MAX_SITE_FONT_FILES; i++) {
      await s.setDoc(paths.font(OWNER, SITE, `seed${i}`), { family: `Seed ${i}`, weight: 400, style: 'normal', file: { format: 'woff2', bytes: 1, sha256: String(i).padStart(64, '0'), key: `k${i}` }, licence: { confirmed: true, by: 'x', at: '' }, created_at: '2026-01-01T00:00:00Z', storage: { provider: 'datastore' } });
    }
    const full = await call('index', 'POST', '', upload(testTrueTypeFont({ family: 'One More' })));
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'font_library_full' });
  });

  it('inspects a file without saving it', async () => {
    const response = await call('inspect', 'POST', '/inspect', upload(testTrueTypeFont(), {}));
    expect(await response.json()).toMatchObject({ info: { format: 'ttf', family: 'Test Sans', weight: 600, italic: true } });
    const { listSiteFonts } = await import('../../lib/fonts/font-library');
    expect(await listSiteFonts(OWNER, SITE)).toEqual([]);
  });

  it('keeps reads open to readers and writes to administrators', async () => {
    permission = 'write';
    expect((await call('index', 'POST', '', upload(testTrueTypeFont()))).status).toBe(403);
    permission = 'read';
    expect((await call('index', 'GET', '')).status).toBe(200);
    expect((await call('inspect', 'POST', '/inspect', upload(testTrueTypeFont()))).status).toBe(403);
    expect((await call('[fontId]', 'DELETE', '/x')).status).toBe(403);
  });
});

describe('the library', () => {
  it('lists the files with the roles that use each family, serves the WOFF2 and deletes with a warning', async () => {
    const font = (await (await call('index', 'POST', '', upload(testTrueTypeFont()))).json() as { font: SiteFontFile }).font;
    const list = await (await call('index', 'GET', '')).json() as { fonts: SiteFontFile[]; used_by: Record<string, string[]> };
    expect(list.fonts.map(f => f.id)).toEqual([font.id]);
    // Display follows heading while it is unset.
    expect(list.used_by).toEqual({ 'Test Sans': ['heading', 'display'] });

    const file = await call('[fontId]/file', 'GET', `/${font.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('font/woff2');
    expect(file.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(file.headers.get('etag')).toBe(`"${font.file.sha256}"`);
    expect(sha(new Uint8Array(await file.arrayBuffer()))).toBe(font.file.sha256);
    expect((await call('[fontId]/file', 'GET', `/${font.id}/file`, undefined, { 'if-none-match': `"${font.file.sha256}"` })).status).toBe(304);

    const renamed = await call('[fontId]', 'PATCH', `/${font.id}`, { family: 'Brand Sans', licence_note: 'Updated' });
    expect((await renamed.json() as { font: SiteFontFile }).font).toMatchObject({ family: 'Brand Sans', licence: { note: 'Updated', by: 'admin@example.com' } });
    expect((await call('[fontId]', 'PATCH', `/${font.id}`, { colour: 'red' })).status).toBe(400);
    await call('[fontId]', 'PATCH', `/${font.id}`, { family: 'Test Sans' });

    const deleted = await call('[fontId]', 'DELETE', `/${font.id}`);
    expect(await deleted.json()).toMatchObject({ deleted: true, warning: expect.stringContaining('heading, display') });
    expect(await (await store()).listDocs(`${paths.font(OWNER, SITE, font.id)}/bytes`)).toEqual([]);
    expect((await call('[fontId]/file', 'GET', `/${font.id}/file`)).status).toBe(404);
    expect((await call('[fontId]', 'DELETE', `/${font.id}`)).status).toBe(404);
  });

  it('refuses bytes that changed in storage', async () => {
    const font = (await (await call('index', 'POST', '', upload(testTrueTypeFont()))).json() as { font: SiteFontFile }).font;
    const s = await store();
    const [chunk] = await s.listDocs<{ key: string; data: string }>(`${paths.font(OWNER, SITE, font.id)}/bytes`);
    const target = (await s.listDocs<{ key: string }>(`${paths.font(OWNER, SITE, font.id)}/bytes`)).find(c => c.key === font.file.key)!;
    await s.updateDoc(`${paths.font(OWNER, SITE, font.id)}/bytes/${target.id}`, { data: Buffer.from('tampered').toString('base64') });
    expect(chunk).toBeDefined();
    const { readSiteFontBytes } = await import('../../lib/fonts/font-library');
    await expect(readSiteFontBytes(OWNER, SITE, font)).rejects.toThrow(/integrity/);
  });
});

describe('font storage', () => {
  it('splits large files into chunks that fit a document', async () => {
    const { putFontObject, getFontObject, FONT_CHUNK_BYTES } = await import('../../lib/fonts/font-storage');
    const bytes = new Uint8Array(FONT_CHUNK_BYTES * 2 + 17).map((_, i) => i % 251);
    await putFontObject(OWNER, SITE, 'big', { provider: 'datastore' }, 'private/x/fonts/big.woff2', bytes, 'font/woff2');
    await putFontObject(OWNER, SITE, 'big', { provider: 'datastore' }, 'private/x/fonts/originals/big.ttf', new Uint8Array([1, 2, 3]), 'font/ttf');
    expect(await (await store()).listDocs(`${paths.font(OWNER, SITE, 'big')}/bytes`)).toHaveLength(4);
    expect(Buffer.from(await getFontObject(OWNER, SITE, 'big', { provider: 'datastore' }, 'private/x/fonts/big.woff2')).equals(Buffer.from(bytes))).toBe(true);
    expect([...await getFontObject(OWNER, SITE, 'big', { provider: 'datastore' }, 'private/x/fonts/originals/big.ttf')]).toEqual([1, 2, 3]);
  });

  it('uses the organization\'s private R2 bucket once it is media ready, and the platform private bucket before', async () => {
    const objects = new Map<string, { body: Uint8Array; contentType?: string; cacheControl?: string }>();
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
      if (command instanceof PutObjectCommand) { const i = command.input; objects.set(`${i.Bucket}/${i.Key}`, { body: i.Body as Uint8Array, contentType: i.ContentType, cacheControl: i.CacheControl }); return {}; }
      if (command instanceof GetObjectCommand) {
        const found = objects.get(`${command.input.Bucket}/${command.input.Key}`);
        if (!found) throw new Error('NoSuchKey');
        return { Body: { transformToByteArray: async () => found.body } };
      }
      if (command instanceof DeleteObjectCommand) { objects.delete(`${command.input.Bucket}/${command.input.Key}`); return {}; }
      throw new Error('Unexpected S3 operation');
    }) as never);
    vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
    vi.stubEnv('R2_PRIVATE_BUCKET', 'platform-private');
    vi.stubEnv('R2_BUCKET', 'platform-public');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-key');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-secret');
    const draft = (await (await call('index', 'POST', '', upload(testTrueTypeFont({ family: 'Draft Sans' })))).json() as { font: SiteFontFile }).font;
    expect([...objects.keys()].sort()).toEqual([`platform-private/${draft.file.key}`, `platform-private/${draft.original!.key}`].sort());
    expect(objects.get(`platform-private/${draft.file.key}`)).toMatchObject({ contentType: 'font/woff2', cacheControl: 'private, no-store' });

    vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
    const { connectionPath, sealCredentials, getConnection } = await import('../../lib/publishing/connections');
    await getConnection(OWNER, 'cloudflare');
    await (await store()).updateDoc(connectionPath(OWNER, 'cloudflare'), { status: 'connected', media_ready: true, auth_method: 'api_token',
      cloudflare: { account_id: 'a'.repeat(32), account_name: 'Org', bucket: 'org-originals', public_bucket: 'org-public', endpoint: 'https://example.test' },
      encrypted_credentials: sealCredentials(OWNER, 'cloudflare', { api_token: 'synthetic-cf', access_key_id: 'synthetic-key', secret_access_key: 'synthetic-secret' }) });
    const own = (await (await call('index', 'POST', '', upload(testTrueTypeFont({ family: 'Own Sans' })))).json() as { font: SiteFontFile }).font;
    expect(objects.has(`org-originals/${own.file.key}`)).toBe(true);

    // The draft file stays readable where it was stored.
    const { readSiteFontBytes } = await import('../../lib/fonts/font-library');
    expect(sha(await readSiteFontBytes(OWNER, SITE, draft))).toBe(draft.file.sha256);
    await call('[fontId]', 'DELETE', `/${own.id}`);
    expect(objects.has(`org-originals/${own.file.key}`)).toBe(false);
    expect(objects.has(`org-originals/${own.original!.key}`)).toBe(false);
  });
});

describe('font services', () => {
  it('reads the families of an Adobe Fonts kit and a Bunny Fonts stylesheet through the guarded fetch', async () => {
    const requested: string[] = [];
    vi.doMock('../../lib/net/safe-fetch', async load => ({
      ...await load<object>(),
      createSafeFetch: () => (async (input: string | URL) => {
        requested.push(String(input));
        if (String(input) === 'https://use.typekit.net/abc1234.css') return new Response('@font-face{font-family:"brand-sans";src:url(x)}@font-face{font-family:"brand-sans";font-weight:700}@font-face{font-family:"brand-serif"}', { status: 200 });
        if (String(input).startsWith('https://fonts.bunny.net/css')) return new Response("@font-face { font-family: 'Lato'; }", { status: 200 });
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    }));
    const adobe = await call('services/inspect', 'POST', '/services/inspect', { provider: 'adobe', kit: 'abc1234' });
    expect(await adobe.json()).toEqual({ families: ['brand-sans', 'brand-serif'], stylesheet: 'https://use.typekit.net/abc1234.css' });
    const bunny = await call('services/inspect', 'POST', '/services/inspect', { provider: 'bunny', url: 'https://fonts.bunny.net/css?family=lato:400,700' });
    expect(await bunny.json()).toMatchObject({ families: ['Lato'] });
    const missing = await call('services/inspect', 'POST', '/services/inspect', { provider: 'adobe', kit: 'zzzzz99' });
    expect(missing.status).toBe(502);
    expect(await missing.json()).toMatchObject({ code: 'font_source_unavailable' });
    expect((await call('services/inspect', 'POST', '/services/inspect', { provider: 'bunny', url: 'https://evil.example/css' })).status).toBe(400);
    expect((await call('services/inspect', 'POST', '/services/inspect', { provider: 'google', url: 'x' })).status).toBe(400);
    expect(requested).toHaveLength(3);
  });
});

describe('the Settings form', () => {
  async function save(fields: Record<string, string>): Promise<Response> {
    const mod = (await import('../../pages/api/sites/[siteId]/settings')) as Partial<Record<string, APIRoute>>;
    const form = new FormData();
    form.set('settings_section', 'design');
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const request = new Request(`http://localhost/api/sites/${SITE}/settings`, { method: 'POST', body: form, headers: { accept: 'application/json' } });
    return mod.POST!({ request, params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {}, redirect: () => new Response(null, { status: 302 }) } as never) as Promise<Response>;
  }
  const fonts = async () => (await (await store()).getDoc<{ fonts: Record<string, unknown> }>(paths.settings(OWNER, SITE, MAIN_VERSION_ID)))!.fonts;

  it('saves display, accent, services and load, clears them when empty and validates them', async () => {
    const services = JSON.stringify([{ provider: 'bunny', url: 'https://fonts.bunny.net/css?family=lato:400', families: ['Lato'] }]);
    const saved = await save({ 'fonts.heading': 'Inter', 'fonts.display': 'Lato', 'fonts.accent': 'Mystery Face', 'fonts.services': services, 'fonts.load': JSON.stringify({ body: { weights: [300] } }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ saved: true, warnings: [expect.stringContaining('fonts.accent "Mystery Face"')] });
    expect(await fonts()).toMatchObject({ heading: 'Inter', display: 'Lato', accent: 'Mystery Face', services: [{ provider: 'bunny' }], load: { body: { weights: [300] } } });

    expect((await save({ 'fonts.load': '{"body":{"weights":[350]}}' })).status).toBe(400);
    expect((await save({ 'fonts.services': 'not json' })).status).toBe(400);
    expect((await save({ 'fonts.services': JSON.stringify([{ provider: 'adobe', kit: 'NOPE', families: [] }]) })).status).toBe(400);

    expect((await save({ 'fonts.display': '', 'fonts.accent': '', 'fonts.services': '', 'fonts.load': '' })).status).toBe(200);
    const cleared = await fonts();
    for (const key of ['display', 'accent', 'services', 'load']) expect(cleared).not.toHaveProperty(key);
    expect(cleared.heading).toBe('Inter');
  });
});
