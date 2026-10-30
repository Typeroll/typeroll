import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureThemeFonts, themeFontsCssUrl, type FrozenThemeFonts } from '../extensions/theme-fonts';
import { createSafeFetch } from '../net/safe-fetch';
import { ConnectionError } from './connections';

type Fonts = Parameters<typeof themeFontsCssUrl>[0];
const ATTEMPTS = 3;

/**
 * Typeroll copies a self-hosted theme's font files while freezing the
 * publication, so every build engine renders them without network access and
 * without Google. A transient failure is retried; when Google stays
 * unreachable the previous publication's identical fonts are reused, and
 * otherwise the publication stops before anything changes.
 */
export async function freezeThemeFonts(fonts: Fonts, previous: FrozenThemeFonts | null | undefined, options: { fetchImpl?: typeof fetch; delay?: (ms: number) => Promise<void> } = {}): Promise<FrozenThemeFonts | null> {
  const cssUrl = themeFontsCssUrl(fonts);
  if (!cssUrl) return null;
  const fetchImpl = options.fetchImpl ?? createSafeFetch({ label: 'Asset URL', maxRedirects: 0, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let lastError = 'Theme fonts could not be copied';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-theme-fonts-'));
    try {
      return await captureThemeFonts(work, fonts, fetchImpl);
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      if (attempt < ATTEMPTS) await delay(attempt * 1500);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }
  if (previous?.css_url === cssUrl && previous.files?.length) {
    console.warn(JSON.stringify({ event: 'theme_fonts_reused', css_url: cssUrl, error: lastError }));
    return previous;
  }
  throw new ConnectionError(`The theme fonts could not be copied from Google Fonts (${lastError}). Nothing was published and the live site is unchanged. Retry the publication; to load fonts from the Google Fonts CDN instead, set fonts.delivery to "google".`, 503, 'theme_fonts_unavailable');
}
