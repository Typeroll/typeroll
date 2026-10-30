import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { makeTmpFixtures } from '../helpers/tmp-fixtures';
import { vendorThemeFonts } from '../../lib/extensions/theme-fonts';
import { installAssetCache, prepareAssets } from '../../lib/builds/assets.mjs';
import { rewriteGoogleFontCss, googleFontFileUrls, fontDelivery } from '@typeroll/shared';

const css = `/* latin */
@font-face { font-family: 'Sofia Sans'; font-style: normal; font-weight: 400 700; font-display: swap; src: url(https://fonts.gstatic.com/s/sofiasans/v1/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }
/* latin-ext */
@font-face { font-family: 'Sofia Sans'; font-style: normal; font-weight: 400 700; font-display: swap; src: url(https://fonts.gstatic.com/s/sofiasans/v1/latin-ext.woff2) format('woff2'); unicode-range: U+0100-024F; }
@font-face { font-family: 'Evil'; src: url(https://evil.example/x.woff2) format('woff2'); }`;
const network = () => vi.fn(async (url: any) => new Response(String(url).includes('googleapis') ? css : `font:${String(url)}`));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps only gstatic font files and rewrites them to the site origin', () => {
  expect(googleFontFileUrls(css)).toEqual(['https://fonts.gstatic.com/s/sofiasans/v1/latin.woff2', 'https://fonts.gstatic.com/s/sofiasans/v1/latin-ext.woff2']);
  const rewritten = rewriteGoogleFontCss(css, new Map([['https://fonts.gstatic.com/s/sofiasans/v1/latin.woff2', '/_typeroll/fonts/a.woff2']]));
  expect(rewritten).toContain('url(/_typeroll/fonts/a.woff2)');
  expect(rewritten).not.toMatch(/gstatic|googleapis|evil/);
  expect(fontDelivery(undefined)).toBe('self_hosted');
  expect(fontDelivery({ delivery: 'google' })).toBe('google');
});

it('copies theme fonts into the build so pages never request Google', async () => {
  const dir = makeTmpFixtures().dir;
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  const fetch = network();
  const result = await vendorThemeFonts(dir, { heading: 'Sofia Sans', body: 'system-ui' }, fetch as any);
  expect(result).toMatchObject({ delivery: 'self_hosted', files: 2 });
  expect(String(fetch.mock.calls[0][0])).toBe('https://fonts.googleapis.com/css2?family=Sofia%20Sans:wght@400;500;600;700&display=swap');
  const stylesheet = await fs.readFile(path.join(dir, '_typeroll/fonts/fonts.css'), 'utf8');
  expect(stylesheet).not.toMatch(/gstatic|googleapis|evil/);
  const files = stylesheet.match(/\/_typeroll\/fonts\/[a-f0-9]{32}\.woff2/g)!;
  expect(files).toHaveLength(2);
  for (const file of files) expect(await fs.readFile(path.join(dir, file))).toBeTruthy();
});

it('falls back to local fonts without failing the build or contacting Google from pages', async () => {
  const dir = makeTmpFixtures().dir;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  const result = await vendorThemeFonts(dir, { heading: 'Sofia Sans', body: 'Sofia Sans' }, vi.fn(async () => new Response('', { status: 503 })) as any);
  expect(result.error).toContain('503');
  expect(await fs.readFile(path.join(dir, '_typeroll/fonts/fonts.css'), 'utf8')).toMatch(/^\/\* Theme fonts could not be copied/);
});

it('leaves Google delivery and system fonts alone', async () => {
  const dir = makeTmpFixtures().dir, fetch = network();
  expect(await vendorThemeFonts(dir, { heading: 'Sofia Sans', body: 'Sofia Sans', delivery: 'google' }, fetch as any)).toMatchObject({ delivery: 'google', files: 0 });
  expect(await vendorThemeFonts(dir, { heading: 'system-ui', body: 'system' }, fetch as any)).toMatchObject({ delivery: 'none' });
  expect(fetch).not.toHaveBeenCalled();
});

it('prefetches theme fonts in the trusted stage and replays them while rendering offline', async () => {
  const root = makeTmpFixtures().dir;
  await fs.mkdir(path.join(root, '.typeroll-runner'));
  const target = path.join(root, 'scripts/source/extensions'); await fs.mkdir(target, { recursive: true });
  for (const name of ['assets.ts', 'public-http.ts', 'theme-fonts.ts']) await fs.copyFile(path.resolve('src/lib/extensions', name), path.join(target, name));
  await fs.cp(path.resolve('../shared/src'), path.join(root, 'packages/shared/src'), { recursive: true, filter: file => !file.includes('__tests__') });
  const fonts = { heading: 'Sofia Sans', body: 'Sofia Sans' };
  await fs.writeFile(path.join(root, 'publication.json'), JSON.stringify({ settings: { fonts } }));
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  vi.stubGlobal('fetch', network());
  await prepareAssets(root);
  const offline = vi.fn(async () => { throw Error('network unavailable'); }); vi.stubGlobal('fetch', offline);
  const restore = await installAssetCache(root);
  try {
    const dist = path.join(root, 'dist');
    expect(await vendorThemeFonts(dist, fonts)).toMatchObject({ delivery: 'self_hosted', files: 2 });
    expect(offline).not.toHaveBeenCalled();
  } finally { restore(); }
});

it('reuses the fonts a build workspace copied before, so rebuilding is identical', async () => {
  const root = makeTmpFixtures().dir, cacheDir = path.join(root, '.publication-fonts');
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  await vendorThemeFonts(first, { heading: 'Sofia Sans' }, network() as any, { cacheDir });
  // A different edge would serve different bytes; the cached copy wins.
  const changed = vi.fn(async (url: any) => new Response(String(url).includes('googleapis') ? css : 'other bytes'));
  expect(await vendorThemeFonts(second, { heading: 'Sofia Sans' }, changed as any, { cacheDir })).toMatchObject({ delivery: 'self_hosted', files: 2 });
  expect(changed).not.toHaveBeenCalled();
  const list = async (dir: string) => Object.fromEntries(await Promise.all((await fs.readdir(path.join(dir, '_typeroll/fonts'))).map(async name => [name, (await fs.readFile(path.join(dir, '_typeroll/fonts', name))).toString('base64')])));
  expect(await list(second)).toEqual(await list(first));
});
