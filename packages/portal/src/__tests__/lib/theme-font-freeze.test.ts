import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { makeTmpFixtures } from '../helpers/tmp-fixtures';
import { freezeThemeFonts } from '../../lib/publishing/theme-font-freeze';
import { writeFrozenThemeFonts } from '../../lib/extensions/theme-fonts';

const css = "@font-face { font-family: 'Sofia Sans'; src: url(https://fonts.gstatic.com/s/sofia/a.woff2) format('woff2'); }";
const google = () => vi.fn(async (url: any) => new Response(String(url).includes('googleapis') ? css : 'font bytes'));
const delay = async () => {};
afterEach(() => vi.restoreAllMocks());

it('freezes the theme font files with sha256 and a same-origin stylesheet', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  const frozen = await freezeThemeFonts({ heading: 'Sofia Sans', body: 'Sofia Sans' }, null, { fetchImpl: google() as any, delay });
  expect(frozen?.css_url).toContain('family=Sofia%20Sans');
  expect(frozen?.css).toMatch(/url\(\/_typeroll\/fonts\/[a-f0-9]{32}\.woff2\)/);
  expect(frozen?.files).toEqual([expect.objectContaining({ data: Buffer.from('font bytes').toString('base64'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect(await freezeThemeFonts({ heading: 'Sofia Sans', body: 'Sofia Sans', delivery: 'google' }, null, { fetchImpl: google() as any, delay })).toBeNull();
  expect(await freezeThemeFonts({ heading: 'system-ui', body: 'system' }, null, { fetchImpl: google() as any, delay })).toBeNull();
});

it('retries a transient DNS failure, then reuses identical earlier fonts, then stops the publication', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const lookup = vi.spyOn(dns, 'lookup');
  lookup.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo EAI_AGAIN fonts.googleapis.com'), { code: 'EAI_AGAIN' }));
  lookup.mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  const fonts = { heading: 'Sofia Sans', body: 'Sofia Sans' };
  const recovered = await freezeThemeFonts(fonts, null, { fetchImpl: google() as any, delay });
  expect(recovered?.files).toHaveLength(1);
  const down = vi.fn(async () => new Response('', { status: 503 }));
  expect(await freezeThemeFonts(fonts, recovered, { fetchImpl: down as any, delay })).toBe(recovered);
  expect(down).toHaveBeenCalledTimes(3);
  await expect(freezeThemeFonts({ heading: 'Inter', body: 'Inter' }, recovered, { fetchImpl: down as any, delay })).rejects.toMatchObject({ code: 'theme_fonts_unavailable', status: 503 });
});

it('writes frozen fonts only after verifying each file', async () => {
  const dir = makeTmpFixtures().dir;
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.1', family: 4 }] as any);
  const frozen = (await freezeThemeFonts({ heading: 'Sofia Sans' }, null, { fetchImpl: google() as any, delay }))!;
  expect(await writeFrozenThemeFonts(dir, frozen)).toBe(1);
  expect(await fs.readFile(path.join(dir, '_typeroll/fonts/fonts.css'), 'utf8')).toBe(frozen.css);
  expect(await fs.readFile(path.join(dir, '_typeroll/fonts', frozen.files[0].name), 'utf8')).toBe('font bytes');
  await expect(writeFrozenThemeFonts(dir, { ...frozen, files: [{ ...frozen.files[0], data: Buffer.from('tampered').toString('base64') }] })).rejects.toThrow('integrity');
  await expect(writeFrozenThemeFonts(dir, { ...frozen, files: [{ ...frozen.files[0], name: '../escape.woff2' }] })).rejects.toThrow('name');
});
