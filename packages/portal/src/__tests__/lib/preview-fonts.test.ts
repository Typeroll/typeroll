import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { MAIN_VERSION_ID, paths, type Page, type SiteFontFile, type SiteSettings } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const library = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock('../../lib/fonts/font-library', () => ({ listSiteFonts: library.list, readSiteFontBytes: library.read }));
const { clearPreviewFontCache, servePreviewFont, signPreviewFontToken, verifyPreviewFontToken } = await import('../../lib/fonts/preview-fonts');

const ORG = 'orgone', SITE = 'mysite';
const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const font: SiteFontFile = {
  id: 'font-1', family: 'Brand', weight: 400, style: 'normal',
  file: { format: 'woff2', bytes: bytes.byteLength, sha256: sha, key: 'k' },
  licence: { confirmed: true, by: 'u', at: '2026-11-01T00:00:00Z' }, created_at: '2026-11-01T00:00:00Z',
};
const googleCssUrl = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
const googleCss = "@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/s/inter/v1/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }";
const network = () => vi.fn(async (url: any) => new Response(String(url).includes('googleapis') ? googleCss : 'google font bytes'));

beforeEach(() => {
  vi.stubEnv('PREVIEW_HMAC_SECRET', 'x'.repeat(40));
  vi.stubEnv('PORTAL_PUBLIC_URL', '');
  library.list.mockReset().mockResolvedValue([font]);
  library.read.mockReset().mockResolvedValue(bytes);
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  clearPreviewFontCache();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('preview font route', () => {
  it('accepts only its own signed, unexpired tokens', () => {
    const now = Date.parse('2026-11-07T10:20:00Z');
    const token = signPreviewFontToken({ orgId: ORG, siteId: SITE, googleCssUrl, fileIds: ['font-1'] }, now)!;
    expect(verifyPreviewFontToken(token, now)).toMatchObject({ o: ORG, s: SITE, g: googleCssUrl, f: ['font-1'] });
    // Stable within the hour, so the canvas keeps one stylesheet URL.
    expect(signPreviewFontToken({ orgId: ORG, siteId: SITE, googleCssUrl, fileIds: ['font-1'] }, now + 30 * 60_000)).toBe(token);
    expect(verifyPreviewFontToken(token, now + 2 * 60 * 60_000 + 1)).toBeNull();
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), s: 'other' })).toString('base64url');
    expect(verifyPreviewFontToken(`${forged}.${signature}`, now)).toBeNull();
    // A preview page token's signature is not a font token's.
    const pageSignature = crypto.createHmac('sha256', 'x'.repeat(40)).update(payload).digest('base64url');
    expect(verifyPreviewFontToken(`${payload}.${pageSignature}`, now)).toBeNull();
    vi.stubEnv('PREVIEW_HMAC_SECRET', '');
    expect(signPreviewFontToken({ orgId: ORG, siteId: SITE, fileIds: ['font-1'] })).toBeNull();
  });

  it('serves the stylesheet and files with CORS for opaque-origin previews', async () => {
    const token = signPreviewFontToken({ orgId: ORG, siteId: SITE, googleCssUrl, fileIds: ['font-1'] })!;
    const fetch = network();
    const css = await servePreviewFont(token, 'fonts.css', fetch as any);
    expect(css.status).toBe(200);
    expect(css.headers.get('access-control-allow-origin')).toBe('*');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const text = await css.text();
    const latin = `g/h/${crypto.createHash('sha256').update('https://fonts.gstatic.com/s/inter/v1/latin.woff2').digest('hex').slice(0, 32)}`;
    expect(text).toContain(`url(${latin})`);
    expect(text).toContain(`font-family:'Brand';font-style:normal;font-weight:400;font-display:swap;src:url(${sha.slice(0, 32)}.woff2) format('woff2')`);
    expect(text).not.toContain('gstatic');

    const uploaded = await servePreviewFont(token, `${sha.slice(0, 32)}.woff2`, fetch as any);
    expect(uploaded.headers.get('access-control-allow-origin')).toBe('*');
    expect(uploaded.headers.get('content-type')).toBe('font/woff2');
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(bytes);

    const proxied = await servePreviewFont(token, latin, fetch as any);
    expect(proxied.headers.get('access-control-allow-origin')).toBe('*');
    expect(await proxied.text()).toBe('google font bytes');
    // Google is asked once per URL; the rest comes from the cache.
    await servePreviewFont(token, 'fonts.css', fetch as any);
    await servePreviewFont(token, latin, fetch as any);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Stylesheets cached before files were named by hash still load.
    expect((await servePreviewFont(token, 'g/s/inter/v1/latin.woff2', fetch as any)).status).toBe(200);

    // A newer file version of a family the stylesheet names: another portal
    // instance's cached stylesheet may name it.
    expect((await servePreviewFont(token, 'g/s/inter/v2/latin.woff2', fetch as any)).status).toBe(200);
    // Only files the token and its stylesheet name.
    expect((await servePreviewFont(token, 'g/s/other/v1/x.woff2', fetch as any)).status).toBe(404);
    expect((await servePreviewFont(token, `${'0'.repeat(32)}.woff2`, fetch as any)).status).toBe(404);
    expect((await servePreviewFont(signPreviewFontToken({ orgId: ORG, siteId: SITE })!, `${sha.slice(0, 32)}.woff2`, fetch as any)).status).toBe(404);
    expect((await servePreviewFont(`${token}x`, 'fonts.css', fetch as any)).status).toBe(404);
  });
});

async function seedSite(settings: Partial<SiteSettings>, page: Partial<Page> = {}) {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'Fonts', created_at: new Date().toISOString() });
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
  await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), settings);
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, { id: 'home', title: 'Home', slug: 'home', content_mode: 'html', status: 'published', html_content: '<p>Hello</p>', ...page });
}

describe('renderPreview fonts', () => {
  const render = async () => (await import('../../lib/render-preview')).renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, {});

  it('serves l/font?kit= files and refetches a stylesheet another instance saw', async () => {
    const token = signPreviewFontToken({ orgId: ORG, siteId: SITE, googleCssUrl })!;
    const kit = 'https://fonts.gstatic.com/l/font?kit=abcDEF&skey=0123&v=v20';
    let css = googleCss;
    const fetch = vi.fn(async (url: any) => new Response(String(url).includes('googleapis') ? css : new Uint8Array([0x77, 0x4f, 0x46, 0x32, 9])));
    expect(await (await servePreviewFont(token, 'fonts.css', fetch as any)).text()).not.toContain('kit=');
    // Google now answers with a kit URL; this instance still caches the old stylesheet.
    css = `@font-face { font-family: 'Inter'; src: url(${kit}) format('woff2'); }`;
    const name = `g/h/${crypto.createHash('sha256').update(kit).digest('hex').slice(0, 32)}`;
    const file = await servePreviewFont(token, name, fetch as any);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('font/woff2');
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain(kit);
    expect((await servePreviewFont(token, `g/h/${'0'.repeat(32)}`, fetch as any)).status).toBe(404);
  });

  it('loads self-hosted and uploaded fonts through the signed route, never from Google', async () => {
    await seedSite({ render_version: 15, fonts: { heading: 'Inter', body: 'Brand', size_base: 16 } }, { html_content: '<p>Some <em>emphasis</em></p>' });
    const html = (await render())!;
    const href = /<link rel="stylesheet" href="(\/api\/preview-fonts\/[^/"]+\/fonts\.css)">/.exec(html)?.[1];
    expect(href).toBeTruthy();
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const ticket = verifyPreviewFontToken(href!.split('/')[3]);
    // The page's own usage: heading 700 for Inter, the uploaded body file.
    expect(ticket).toMatchObject({ o: ORG, s: SITE, g: 'https://fonts.googleapis.com/css2?family=Inter:wght@700&display=swap', f: ['font-1'] });
  });

  it('keeps the Google CDN when the site chose it and links font services from their CDN', async () => {
    library.list.mockResolvedValue([]);
    await seedSite({ render_version: 14, fonts: { heading: 'Inter', body: 'proxima-nova', delivery: 'google', size_base: 16, services: [{ provider: 'adobe', kit: 'abc1234', families: ['proxima-nova'] }] } });
    const html = (await render())!;
    expect(html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap">');
    expect(html).toContain('<link rel="stylesheet" href="https://use.typekit.net/abc1234.css">');
    expect(html).not.toContain('/api/preview-fonts/');
  });

  it('still renders when the Fonts library cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    library.list.mockRejectedValue(new Error('storage down'));
    await seedSite({ fonts: { heading: 'Inter', body: 'Inter', size_base: 16 } });
    const html = (await render())!;
    expect(html).toMatch(/\/api\/preview-fonts\/[^/"]+\/fonts\.css/);
  });
});
