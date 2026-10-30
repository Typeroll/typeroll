import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  fontDelivery, googleFontFileUrls, googleFontsCssUrl, rewriteGoogleFontCss, webFontFamilies,
  SELF_HOSTED_FONTS_CSS_PATH, SELF_HOSTED_FONTS_DIRECTORY,
} from '@typeroll/shared';
import { fetchPublicAsset } from './public-http';

// Copied verbatim into the frozen publication runner beside public-http; keep
// imports to Node built-ins, @typeroll/shared and ./public-http.

const MAX_CSS_BYTES = 256 * 1024;
const MAX_FONT_BYTES = 2 * 1024 * 1024;
const MAX_FONT_FILES = 120;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
// Google Fonts serves woff2 with unicode-range subsets only to browsers it recognises.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type Fonts = { heading?: string; body?: string; mono?: string; delivery?: unknown } | undefined;
export interface ThemeFontResult { delivery: 'self_hosted' | 'google' | 'none'; files: number; bytes: number; error?: string }

/**
 * Copy the theme's Google webfonts into the build so published pages load them
 * from the site's own origin. A failure leaves an empty stylesheet: pages fall
 * back to local fonts and never contact Google.
 */
export async function vendorThemeFonts(buildDir: string, fonts: Fonts, fetchImpl: typeof fetch = fetch, options: { cacheDir?: string } = {}): Promise<ThemeFontResult> {
  const families = webFontFamilies(fonts?.heading ?? 'Inter', fonts?.body ?? 'Inter', fonts?.mono);
  if (!families.length) return { delivery: 'none', files: 0, bytes: 0 };
  if (fontDelivery(fonts) === 'google') return { delivery: 'google', files: 0, bytes: 0 };
  const directory = path.join(buildDir, SELF_HOSTED_FONTS_DIRECTORY.replace(/^\//, ''));
  const cssPath = path.join(buildDir, SELF_HOSTED_FONTS_CSS_PATH.replace(/^\//, ''));
  await fs.promises.mkdir(directory, { recursive: true });
  const cssUrl = googleFontsCssUrl(families)!;
  // Google can serve different font builds from different edges. A build
  // workspace reuses the files it copied before for the same stylesheet, so
  // rebuilding unchanged settings produces identical output.
  const cached = options.cacheDir ? path.join(options.cacheDir, crypto.createHash('sha256').update(cssUrl).digest('hex').slice(0, 32)) : null;
  if (cached && await restoreCachedFonts(cached, directory)) {
    const names = await fs.promises.readdir(directory);
    let bytes = 0;
    for (const name of names) bytes += (await fs.promises.stat(path.join(directory, name))).size;
    return { delivery: 'self_hosted', files: names.filter(name => name !== path.basename(cssPath)).length, bytes };
  }
  try {
    const css = new TextDecoder().decode(await fetchPublicAsset(cssUrl, MAX_CSS_BYTES, fetchImpl, { 'User-Agent': BROWSER_USER_AGENT }));
    const urls = googleFontFileUrls(css);
    if (!urls.length) throw new Error('The font stylesheet named no font files');
    if (urls.length > MAX_FONT_FILES) throw new Error(`The theme fonts need more than ${MAX_FONT_FILES} files`);
    const local = new Map<string, string>();
    let bytes = 0;
    for (const url of urls) {
      const file = await fetchPublicAsset(url, MAX_FONT_BYTES, fetchImpl, { 'User-Agent': BROWSER_USER_AGENT });
      bytes += file.byteLength;
      if (bytes > MAX_TOTAL_BYTES) throw new Error('The theme fonts exceed the size limit');
      const extension = /\.(woff2?|ttf|otf)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? 'woff2';
      const name = `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 32)}.${extension}`;
      const target = path.join(directory, name);
      await fs.promises.writeFile(target, file);
      local.set(url, `${SELF_HOSTED_FONTS_DIRECTORY}${name}`);
    }
    await fs.promises.writeFile(cssPath, rewriteGoogleFontCss(css, local) + '\n');
    if (cached) {
      // Only a complete copy is cached; a failed one is retried next build.
      await fs.promises.rm(cached, { recursive: true, force: true });
      await fs.promises.cp(directory, cached, { recursive: true });
    }
    return { delivery: 'self_hosted', files: local.size, bytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Theme fonts could not be copied';
    await fs.promises.writeFile(cssPath, `/* Theme fonts could not be copied at build time (${message.replace(/\*\//g, '')}); local fallback fonts are used. */\n`);
    console.warn(JSON.stringify({ event: 'theme_fonts_unavailable', families, error: message }));
    return { delivery: 'self_hosted', files: 0, bytes: 0, error: message };
  }
}

async function restoreCachedFonts(cached: string, directory: string): Promise<boolean> {
  try {
    const names = await fs.promises.readdir(cached);
    if (!names.includes('fonts.css') || names.some(name => !/^(?:[a-f0-9]{32}\.(?:woff2?|ttf|otf)|fonts\.css)$/.test(name))) return false;
    for (const name of names) await fs.promises.copyFile(path.join(cached, name), path.join(directory, name));
    return true;
  } catch { return false; }
}
