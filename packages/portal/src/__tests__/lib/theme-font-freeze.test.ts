import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { fallbackOverrides, readFontFile, siteThemeCss, webfontFallbackCss, type SiteFontFile } from '@typeroll/shared';
import { makeTmpFixtures } from '../helpers/tmp-fixtures';
import { FONT_CODECS } from '../../lib/fonts/codecs';

const library = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
// The Fonts library is another module's storage; these tests give it fixed files.
vi.mock('../../lib/fonts/font-library', () => ({ listSiteFonts: library.list, readSiteFontBytes: library.read }));
const { freezeSiteFonts } = await import('../../lib/publishing/theme-font-freeze');
const { writeFrozenThemeFonts } = await import('../../lib/extensions/theme-fonts');

// A real variable WOFF2 (Fraunces, OFL) stands in for every font file.
const fraunces = new Uint8Array(readFileSync(path.resolve('../docs-site/public/brand/fonts/fraunces-latin-normal.woff2')));
const frauncesInfo = readFontFile(fraunces, FONT_CODECS);
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

const css = "@font-face { font-family: 'Sofia Sans'; src: url(https://fonts.gstatic.com/s/sofia/a.woff2) format('woff2'); }";
const google = (body = css, file: Uint8Array | string = 'font bytes') => vi.fn(async (url: any) => new Response(String(url).includes('googleapis') ? body : file as any));
const delay = async () => {};
const site = { orgId: 'org', siteId: 'site' };
const publication = (fonts: Record<string, unknown>, extra: Record<string, any> = {}) => ({
  settings: { fonts, ...extra.settings },
  pages: extra.pages ?? [{ id: 'home', content_mode: 'html', html_content: '<p>Hello</p>' }],
  partials: extra.partials ?? [], pageTemplates: [], blockTypes: [], forms: [],
});
const uploaded = (overrides: Partial<SiteFontFile> = {}): SiteFontFile => ({
  id: 'font-1', family: 'Brand Serif', weight: [100, 900], style: 'normal',
  file: { format: 'woff2', bytes: fraunces.byteLength, sha256: sha(fraunces), key: 'fonts/font-1.woff2' },
  metrics: frauncesInfo.metrics, category: 'serif',
  licence: { confirmed: true, by: 'user', at: '2026-11-01T00:00:00Z' }, created_at: '2026-11-01T00:00:00Z', ...overrides,
});

beforeEach(() => {
  library.list.mockReset(); library.read.mockReset();
  library.list.mockResolvedValue([]);
  library.read.mockResolvedValue(fraunces);
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
});
afterEach(() => vi.restoreAllMocks());

it('freezes the theme font files with sha256 and a same-origin stylesheet', async () => {
  const frozen = await freezeSiteFonts(publication({ heading: 'Sofia Sans', body: 'Sofia Sans' }), null, site, { fetchImpl: google() as any, delay });
  expect(frozen.theme_fonts?.css_url).toContain('family=Sofia%20Sans');
  expect(frozen.theme_fonts?.css).toMatch(/url\(\/_typeroll\/fonts\/[a-f0-9]{32}\.woff2\)/);
  expect(frozen.theme_fonts?.files).toEqual([expect.objectContaining({ data: Buffer.from('font bytes').toString('base64'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect((await freezeSiteFonts(publication({ heading: 'Sofia Sans', body: 'Sofia Sans', delivery: 'google' }), null, site, { fetchImpl: google() as any, delay })).theme_fonts).toBeNull();
  const system = await freezeSiteFonts(publication({ heading: 'system-ui', body: 'system' }), null, site, { fetchImpl: google() as any, delay });
  expect(system.theme_fonts).toBeNull();
  expect(system.plan.families).toEqual([]);
});

it('keeps the frozen output of render versions before 15 unchanged', async () => {
  const fetch = google();
  const frozen = await freezeSiteFonts(publication({ heading: 'inter', body: 'Sofia Sans', mono: 'Roboto Mono' }, { settings: { render_version: 14 } }), null, site, { fetchImpl: fetch as any, delay });
  // The exact request and record earlier Cores made: the families as written, 400–700.
  const legacy = 'https://fonts.googleapis.com/css2?family=inter:wght@400;500;600;700&family=Sofia%20Sans:wght@400;500;600;700&family=Roboto%20Mono:wght@400;500;600;700&display=swap';
  expect(String(fetch.mock.calls[0][0])).toBe(legacy);
  expect(frozen.plan.google_css_url).toBe(legacy);
  expect(frozen.theme_fonts).toEqual({ css_url: legacy, css: expect.any(String), files: [expect.objectContaining({ name: expect.stringMatching(/^[a-f0-9]{32}\.woff2$/) })] });
  expect(frozen.plan.preload).toBeUndefined();
  expect(frozen.plan.families.some(family => family.fallback)).toBe(false);
  // The theme tokens and fallback faces a v14 page renders do not change with a plan.
  const settings = { render_version: 14, colors: {} as any, fonts: { heading: 'inter', body: 'Sofia Sans', size_base: 16 } };
  expect(siteThemeCss({ ...settings, font_plan: frozen.plan })).toBe(siteThemeCss(settings));
  expect(webfontFallbackCss(14, frozen.plan)).toBe(webfontFallbackCss(14));
});

it('requests only the weights a version 15 site uses, with a fallback and a preload from the copied Latin file', async () => {
  const googleCss = `/* latin-ext */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 400 700; src: url(https://fonts.gstatic.com/s/fraunces/v1/ext.woff2) format('woff2'); unicode-range: U+0100-02BA; }
/* latin */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 400 700; src: url(https://fonts.gstatic.com/s/fraunces/v1/latin.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }`;
  const fetch = vi.fn(async (url: any) => new Response(String(url).includes('googleapis') ? googleCss : String(url).includes('latin.woff2') ? fraunces as any : 'ext bytes'));
  const frozen = await freezeSiteFonts(publication({ heading: 'Fraunces', body: 'Fraunces' }, {
    settings: { render_version: 15 }, pages: [{ id: 'home', content_mode: 'html', html_content: '<p>Some <strong>bold</strong> text</p>' }],
  }), null, site, { fetchImpl: fetch as any, delay });
  expect(String(fetch.mock.calls[0][0])).toBe('https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap');
  const [family] = frozen.plan.families;
  expect(family).toMatchObject({ family: 'Fraunces', source: 'google', weights: [400, 700], fallback: fallbackOverrides(frauncesInfo.metrics, 'serif') });
  const latin = frozen.theme_fonts!.files.find(file => file.data === Buffer.from(fraunces).toString('base64'))!;
  expect(frozen.plan.preload).toBe(`/_typeroll/fonts/${latin.name}`);
  expect(webfontFallbackCss(15, frozen.plan)).toContain("font-family:'Fraunces fallback';src:local('Times New Roman')");
});

it('serves uploaded fonts from the site with their own @font-face rules, also with Google delivery', async () => {
  library.list.mockResolvedValue([uploaded(), uploaded({ id: 'unused', family: 'Other' })]);
  const fetch = google();
  const frozen = await freezeSiteFonts(publication({ heading: 'Sofia Sans', body: 'Brand Serif', delivery: 'google' }, { settings: { render_version: 15 } }), null, site, { fetchImpl: fetch as any, delay });
  expect(fetch).not.toHaveBeenCalled();
  expect(library.read).toHaveBeenCalledTimes(1);
  const name = `${sha(fraunces).slice(0, 32)}.woff2`;
  expect(frozen.theme_fonts).toEqual({ css_url: `#library=${sha(fraunces)}`, files: [{ name, sha256: sha(fraunces), data: Buffer.from(fraunces).toString('base64') }],
    css: `@font-face{font-family:'Brand Serif';font-style:normal;font-weight:100 900;font-display:swap;src:url(/_typeroll/fonts/${name}) format('woff2')}\n` });
  // Google's family still loads from its CDN.
  expect(frozen.plan.google_css_url).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=Sofia%20Sans/);
  expect(frozen.plan.families.find(family => family.source === 'upload')).toMatchObject({ files: ['font-1'], fallback: fallbackOverrides(frauncesInfo.metrics, 'serif') });
  expect(frozen.plan.preload).toBe(`/_typeroll/fonts/${name}`);
  // Older engines write the combined set with the function they already have.
  const dir = makeTmpFixtures().dir;
  expect(await writeFrozenThemeFonts(dir, frozen.theme_fonts!)).toBe(1);
  expect(new Uint8Array(await fs.readFile(path.join(dir, '_typeroll/fonts', name)))).toEqual(fraunces);
});

it('adds uploaded files to self-hosted Google files and keys the set by both', async () => {
  library.list.mockResolvedValue([uploaded({ family: 'Brand', weight: 700 })]);
  const frozen = await freezeSiteFonts(publication({ heading: 'Brand', body: 'Sofia Sans' }), null, site, { fetchImpl: google() as any, delay });
  expect(frozen.theme_fonts!.css_url).toBe(`${frozen.plan.google_css_url}#library=${sha(fraunces)}`);
  expect(frozen.theme_fonts!.files).toHaveLength(2);
  expect(frozen.theme_fonts!.css).toContain("font-family:'Brand';font-style:normal;font-weight:700;");
  // Before version 15 no fallback or preload is added.
  expect(frozen.plan.preload).toBeUndefined();
});

it('stops the publication when an uploaded font cannot be read', async () => {
  library.list.mockResolvedValue([uploaded()]);
  library.read.mockRejectedValue(new Error('object missing'));
  await expect(freezeSiteFonts(publication({ heading: 'Brand Serif' }), null, site, { fetchImpl: google() as any, delay }))
    .rejects.toMatchObject({ code: 'site_fonts_unavailable', status: 503 });
  expect(library.read).toHaveBeenCalledTimes(3);
});

it('loads an all-service site without asking Google, and links its stylesheets from the plan', async () => {
  const fetch = google();
  const frozen = await freezeSiteFonts(publication({ heading: 'proxima-nova', body: 'proxima-nova', services: [{ provider: 'adobe', kit: 'abc1234', families: ['proxima-nova'] }] }), null, site, { fetchImpl: fetch as any, delay });
  expect(fetch).not.toHaveBeenCalled();
  expect(frozen.plan).toMatchObject({ google_css_url: null, service_stylesheets: ['https://use.typekit.net/abc1234.css'] });
  // An empty set, so engines that vendor fonts themselves skip it.
  expect(frozen.theme_fonts).toMatchObject({ files: [] });
});

it('retries a transient DNS failure, then reuses identical earlier fonts, then stops the publication', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const lookup = vi.spyOn(dns, 'lookup');
  lookup.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo EAI_AGAIN fonts.googleapis.com'), { code: 'EAI_AGAIN' }));
  lookup.mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  const fonts = { heading: 'Sofia Sans', body: 'Sofia Sans' };
  const recovered = (await freezeSiteFonts(publication(fonts), null, site, { fetchImpl: google() as any, delay })).theme_fonts;
  expect(recovered?.files).toHaveLength(1);
  const down = vi.fn(async () => new Response('', { status: 503 }));
  expect((await freezeSiteFonts(publication(fonts), recovered, site, { fetchImpl: down as any, delay })).theme_fonts).toBe(recovered);
  expect(down).toHaveBeenCalledTimes(3);
  await expect(freezeSiteFonts(publication({ heading: 'Inter', body: 'Inter' }), recovered, site, { fetchImpl: down as any, delay })).rejects.toMatchObject({ code: 'theme_fonts_unavailable', status: 503 });
});

it('writes frozen fonts only after verifying each file', async () => {
  const dir = makeTmpFixtures().dir;
  const frozen = (await freezeSiteFonts(publication({ heading: 'Sofia Sans' }), null, site, { fetchImpl: google() as any, delay })).theme_fonts!;
  expect(await writeFrozenThemeFonts(dir, frozen)).toBe(1);
  expect(await fs.readFile(path.join(dir, '_typeroll/fonts/fonts.css'), 'utf8')).toBe(frozen.css);
  expect(await fs.readFile(path.join(dir, '_typeroll/fonts', frozen.files[0].name), 'utf8')).toBe('font bytes');
  await expect(writeFrozenThemeFonts(dir, { ...frozen, files: [{ ...frozen.files[0], data: Buffer.from('tampered').toString('base64') }] })).rejects.toThrow('integrity');
  await expect(writeFrozenThemeFonts(dir, { ...frozen, files: [{ ...frozen.files[0], name: '../escape.woff2' }] })).rejects.toThrow('name');
});
