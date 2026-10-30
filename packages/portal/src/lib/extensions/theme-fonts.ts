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
export async function vendorThemeFonts(buildDir: string, fonts: Fonts, fetchImpl: typeof fetch = fetch): Promise<ThemeFontResult> {
  const families = webFontFamilies(fonts?.heading ?? 'Inter', fonts?.body ?? 'Inter', fonts?.mono);
  if (!families.length) return { delivery: 'none', files: 0, bytes: 0 };
  if (fontDelivery(fonts) === 'google') return { delivery: 'google', files: 0, bytes: 0 };
  const cssPath = path.join(buildDir, SELF_HOSTED_FONTS_CSS_PATH.replace(/^\//, ''));
  await fs.promises.mkdir(path.dirname(cssPath), { recursive: true });
  try {
    const css = new TextDecoder().decode(await fetchPublicAsset(googleFontsCssUrl(families)!, MAX_CSS_BYTES, fetchImpl, { 'User-Agent': BROWSER_USER_AGENT }));
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
      const target = path.join(buildDir, SELF_HOSTED_FONTS_DIRECTORY.replace(/^\//, ''), name);
      await fs.promises.writeFile(target, file);
      local.set(url, `${SELF_HOSTED_FONTS_DIRECTORY}${name}`);
    }
    await fs.promises.writeFile(cssPath, rewriteGoogleFontCss(css, local) + '\n');
    return { delivery: 'self_hosted', files: local.size, bytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Theme fonts could not be copied';
    await fs.promises.writeFile(cssPath, `/* Theme fonts could not be copied at build time (${message.replace(/\*\//g, '')}); local fallback fonts are used. */\n`);
    console.warn(JSON.stringify({ event: 'theme_fonts_unavailable', families, error: message }));
    return { delivery: 'self_hosted', files: 0, bytes: 0, error: message };
  }
}
