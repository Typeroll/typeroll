import crypto from 'node:crypto';
import { fontDelivery, resolveRenderVersion, webFontFamilies, type FontPlan, type SiteFontFile } from '@typeroll/shared';
import { captureGoogleFonts, MAX_FONT_FILES, MAX_TOTAL_BYTES, type FrozenThemeFonts } from '../extensions/theme-fonts';
import { completeFontPlan, fontFileName, libraryFontFaceCss, plannedLibraryFiles, publicationFontUsage, siteFontPlan } from '../fonts/font-delivery';
import { listSiteFonts, readSiteFontBytes } from '../fonts/font-library';
import { createSafeFetch } from '../net/safe-fetch';
import { ConnectionError } from './connections';

const ATTEMPTS = 3;
type Options = { fetchImpl?: typeof fetch; delay?: (ms: number) => Promise<void> };

async function withRetries<T>(work: () => Promise<T>, delay: NonNullable<Options['delay']>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try { return await work(); }
    catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await delay(attempt * 1500);
    }
  }
  throw lastError;
}
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export interface FrozenSiteFonts {
  /** The plan the renderer and every build engine load (`settings.font_plan`). */
  plan: FontPlan;
  /** The files to serve from the site itself, or null when nothing is self-hosted. */
  theme_fonts: FrozenThemeFonts | null;
}

/**
 * Typeroll plans the site's fonts and copies every file the site serves
 * itself while freezing the publication, so every build engine renders them
 * without network access, without Google and without the Fonts library.
 *
 * The plan comes from the frozen content (the weights and italics in use,
 * from render version 15). Google files are copied when the site self-hosts;
 * uploaded files are always served from the site. A transient failure is
 * retried. When Google stays unreachable the previous publication's
 * identical fonts are reused; otherwise, and when an uploaded file cannot be
 * read, the publication stops before anything changes.
 *
 * `theme_fonts.css_url` identifies the copied set for that reuse: the Google
 * stylesheet URL, plus `#library=` and the uploaded files' hashes.
 */
export async function freezeSiteFonts(publication: Parameters<typeof publicationFontUsage>[0], previous: FrozenThemeFonts | null | undefined, site: { orgId: string; siteId: string }, options: Options = {}): Promise<FrozenSiteFonts> {
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const fonts = publication.settings?.fonts;
  const renderVersion = resolveRenderVersion(publication.settings?.render_version);
  let library: SiteFontFile[];
  try { library = await withRetries(() => listSiteFonts(site.orgId, site.siteId), delay); }
  catch (error) { throw libraryUnavailable(message(error, 'the Fonts library could not be read')); }
  const plan = siteFontPlan(fonts, publicationFontUsage(publication), { renderVersion, library });

  // Uploaded files first: they are the site's own and need no network.
  const libraryNames = new Map<string, string>();
  const copied = new Map<string, Uint8Array>();
  const rules: string[] = [];
  for (const { family, file } of plannedLibraryFiles(plan, library)) {
    let bytes: Uint8Array;
    try { bytes = await withRetries(() => readSiteFontBytes(site.orgId, site.siteId, file, 'file'), delay); }
    catch (error) { throw libraryUnavailable(`${file.family}: ${message(error, 'the file could not be read')}`); }
    const name = fontFileName(bytes);
    libraryNames.set(file.id, name);
    copied.set(name, bytes);
    rules.push(libraryFontFaceCss(family.family, file, `/_typeroll/fonts/${name}`));
  }
  const librarySums = [...new Set([...libraryNames.values()].map(name => sha256(copied.get(name)!)))];

  const googleCssUrl = fontDelivery(fonts) === 'self_hosted' ? plan.google_css_url : null;
  const cssUrl = `${googleCssUrl ?? ''}${librarySums.length ? `#library=${librarySums.join(',')}` : ''}`;
  let themeFonts: FrozenThemeFonts | null = null;
  if (googleCssUrl) {
    const fetchImpl = options.fetchImpl ?? createSafeFetch({ label: 'Asset URL', maxRedirects: 0, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
    try {
      const google = await withRetries(() => captureGoogleFonts(googleCssUrl, fetchImpl), delay);
      themeFonts = combine(cssUrl, google, rules, copied);
    } catch (error) {
      const lastError = message(error, 'Theme fonts could not be copied');
      if (previous?.css_url !== cssUrl || !previous.files?.length) {
        throw new ConnectionError(`The theme fonts could not be copied from Google Fonts (${lastError}). Nothing was published and the live site is unchanged. Retry the publication; to load fonts from the Google Fonts CDN instead, set fonts.delivery to "google".`, 503, 'theme_fonts_unavailable');
      }
      console.warn(JSON.stringify({ event: 'theme_fonts_reused', css_url: cssUrl, error: lastError }));
      themeFonts = previous;
    }
  } else if (rules.length) {
    themeFonts = combine(cssUrl, null, rules, copied);
  } else if (fontDelivery(fonts) === 'self_hosted' && webFontFamilies(fonts?.heading ?? 'Inter', fonts?.body ?? 'Inter', fonts?.mono).length) {
    // Every family loads from a service: an empty set keeps engines that
    // vendor fonts themselves (no theme_fonts) from asking Google for them.
    themeFonts = { css_url: '', css: '/* No webfonts are served from this site. */\n', files: [] };
  }
  if (themeFonts && themeFonts.files.length) {
    const byName = new Map(themeFonts.files.map(file => [file.name, file.data]));
    completeFontPlan(plan, {
      css: themeFonts.css, library, libraryNames, googleSelfHosted: !!googleCssUrl,
      file: name => copied.get(name) ?? (byName.has(name) ? new Uint8Array(Buffer.from(byName.get(name)!, 'base64')) : undefined),
    });
  }
  return { plan, theme_fonts: themeFonts };
}

const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

function libraryUnavailable(detail: string) {
  return new ConnectionError(`The site's uploaded fonts could not be read (${detail}). Nothing was published and the live site is unchanged. Retry the publication, or replace the file in Fonts.`, 503, 'site_fonts_unavailable');
}

/** Google's copied set plus the uploaded files, in the frozen shape every engine accepts. */
function combine(cssUrl: string, google: FrozenThemeFonts | null, rules: string[], library: Map<string, Uint8Array>): FrozenThemeFonts {
  const files = new Map((google?.files ?? []).map(file => [file.name, file]));
  for (const [name, bytes] of library) if (!files.has(name)) files.set(name, { name, sha256: sha256(bytes), data: Buffer.from(bytes).toString('base64') });
  const sorted = [...files.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const total = sorted.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0);
  if (sorted.length > MAX_FONT_FILES || total > MAX_TOTAL_BYTES) {
    throw new ConnectionError(`The site's fonts need ${sorted.length} files and ${Math.ceil(total / 1024 / 1024)} MB; a publication carries at most ${MAX_FONT_FILES} files and ${MAX_TOTAL_BYTES / 1024 / 1024} MB of fonts. Nothing was published. Remove unused font files or weights in Fonts and publish again.`, 409, 'site_fonts_too_large');
  }
  const css = rules.length ? `${google?.css ?? ''}${rules.join('\n')}\n` : google!.css;
  return { css_url: cssUrl, css, files: sorted };
}
