import crypto from 'node:crypto';
import {
  buildCoreBlockRegistry, collectFontUsage, fallbackOverrides, fontFileWeightRange, FONT_PLAN_RENDER_VERSION, googleFontsCssUrl,
  globalBlockSourceFromPartials, matchFontWeight, planSiteFonts, readFontFile, webFontFamilies, withGlobalBlockContent,
  type Block, type BlockType, type FontPlan, type FontUsage, type PlannedFamily, type SiteFontFile, type SiteSettings,
} from '@typeroll/shared';
import { FONT_CODECS } from './codecs';

// What a publication and the editor preview load for the site's fonts: the
// plan, the @font-face rules of uploaded files, and the metric-matched
// fallback and preload that need the copied files. The freeze
// (publishing/theme-font-freeze.ts) and the preview font route
// (fonts/preview-fonts.ts) share these, so both load the same files.

type Fonts = SiteSettings['fonts'] | undefined;
type Library = ReadonlyArray<SiteFontFile>;

/**
 * The plan for these fonts. Before render version 15 the Google request is
 * exactly the one every earlier Core made (the role families as written,
 * 400–700), without the families the site uploaded or loads from a service,
 * so an unchanged site keeps its stylesheet URL and its frozen files.
 */
export function siteFontPlan(fonts: Fonts, usage: FontUsage, options: { renderVersion: number; library?: Library }): FontPlan {
  const plan = planSiteFonts(fonts, usage, { renderVersion: options.renderVersion, library: options.library });
  if (options.renderVersion < FONT_PLAN_RENDER_VERSION) {
    const sources = new Map(plan.families.map(family => [family.family.trim().toLowerCase(), family.source]));
    const families = webFontFamilies(fonts?.heading ?? 'Inter', fonts?.body ?? 'Inter', fonts?.mono)
      .filter(family => (sources.get(family.trim().toLowerCase()) ?? 'google') === 'google');
    plan.google_css_url = googleFontsCssUrl(families);
  }
  return plan;
}

type Doc = { kind?: string; status?: string; content_mode?: string; blocks?: unknown; html_content?: unknown; fields?: unknown; steps?: Array<{ blocks?: unknown }> };
interface FrozenContent {
  settings?: Partial<SiteSettings>;
  pages?: Doc[]; partials?: Doc[]; pageTemplates?: Doc[]; forms?: Doc[];
  blockTypes?: Array<Pick<BlockType, 'id' | 'schema'>>;
}

/** HTML content (and a page's own fields) counts as body text for bold and italic. */
const textBlock = (data: Record<string, unknown>): Block => ({ id: 'text', type: 'core/prose', data } as Block);

/**
 * The block trees a frozen publication renders: page bodies and their fields,
 * header and footer partials, the page templates in use, form steps, and the
 * global blocks any of them place.
 */
export function publicationFontBlocks(publication: FrozenContent): Block[] {
  const partials = publication.partials ?? [];
  const globalBlocks = globalBlockSourceFromPartials(partials as never);
  const trees: Block[] = [];
  const add = (doc: Doc) => {
    if (Array.isArray(doc.blocks)) trees.push(...withGlobalBlockContent(doc.blocks as Block[], globalBlocks));
    if (typeof doc.html_content === 'string' && doc.html_content) trees.push(textBlock({ html: doc.html_content }));
  };
  for (const page of publication.pages ?? []) {
    add(page);
    if (page.fields && typeof page.fields === 'object') trees.push(textBlock(page.fields as Record<string, unknown>));
  }
  // Global blocks count where they are placed, not because they exist.
  for (const partial of partials) if (partial.kind !== 'free') add(partial);
  for (const template of publication.pageTemplates ?? []) add(template);
  for (const form of publication.forms ?? []) for (const step of form.steps ?? []) add(step);
  return trees;
}

/** Weights and italics a frozen publication uses. */
export function publicationFontUsage(publication: FrozenContent): FontUsage {
  const registry = buildCoreBlockRegistry() as Map<string, Pick<BlockType, 'id' | 'schema'>>;
  for (const type of publication.blockTypes ?? []) if (type?.id) registry.set(type.id, type);
  return collectFontUsage({ styles: publication.settings?.styles, blocks: publicationFontBlocks(publication), blockTypes: registry });
}

// ── Uploaded files ────────────────────────────────────────────────────────

/** Same-origin name of a copied font file: its content hash, as for Google files. */
export const fontFileName = (bytes: Uint8Array, extension = 'woff2') => `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${extension}`;

const cssString = (value: string) => `'${value.replace(/[\\'"\r\n<>;{}()]/g, '')}'`;
const safeUrl = (url: string) => {
  if (!/^[A-Za-z0-9._~/:%-]+$/.test(url)) throw new Error('Unsafe font URL');
  return url;
};

/** The @font-face rule of one uploaded file. */
export function libraryFontFaceCss(family: string, file: Pick<SiteFontFile, 'weight' | 'style'>, url: string): string {
  const [min, max] = fontFileWeightRange(file);
  return `@font-face{font-family:${cssString(family)};font-style:${file.style === 'italic' ? 'italic' : 'normal'};font-weight:${min === max ? min : `${min} ${max}`};font-display:swap;src:url(${safeUrl(url)}) format('woff2')}`;
}

/** The uploaded files a plan loads, with the family name the site's CSS uses. */
export function plannedLibraryFiles(plan: FontPlan, library: Library): Array<{ family: PlannedFamily; file: SiteFontFile }> {
  const byId = new Map(library.map(file => [file.id, file]));
  return plan.families.filter(family => family.source === 'upload').flatMap(family =>
    (family.files ?? []).flatMap(id => byId.has(id) ? [{ family, file: byId.get(id)! }] : []));
}

/** The upright file closest to 400 among candidates, as CSS font matching would choose it for body text. */
function regularFile<T extends Pick<SiteFontFile, 'weight' | 'style'>>(files: readonly T[]): T | undefined {
  const upright = files.filter(file => file.style !== 'italic');
  const covering = upright.find(file => { const [a, b] = fontFileWeightRange(file); return a <= 400 && b >= 400; });
  if (covering) return covering;
  const weight = matchFontWeight(400, upright.flatMap(file => fontFileWeightRange(file)));
  return upright.find(file => fontFileWeightRange(file).includes(weight!));
}

// ── Google stylesheets ────────────────────────────────────────────────────

export interface CssFontFace { family: string; style: string; weight: [number, number]; url: string; latin: boolean }

/** The @font-face rules of a (Google or rewritten) stylesheet. */
export function cssFontFaces(css: string): CssFontFace[] {
  return (css.match(/@font-face\s*\{[^}]*\}/g) ?? []).flatMap(rule => {
    const family = /font-family\s*:\s*(['"]?)([^;'"}]+)\1/i.exec(rule)?.[2]?.trim();
    const url = /url\((['"]?)([^'")\s]+)\1\)/.exec(rule)?.[2];
    if (!family || !url) return [];
    const weights = /font-weight\s*:\s*(\d+)(?:\s+(\d+))?/i.exec(rule);
    const min = Number(weights?.[1] ?? 400), max = Number(weights?.[2] ?? min);
    const range = /unicode-range\s*:\s*([^;}]+)/i.exec(rule)?.[1];
    // Google's latin subset starts at U+0000-00FF; a face without a range covers everything.
    return [{ family, style: /font-style\s*:\s*italic/i.test(rule) ? 'italic' : 'normal', weight: [min, max] as [number, number], url, latin: !range || /U\+0+-0*FF\b/i.test(range) }];
  });
}

/** The upright Latin face of a family closest to 400. */
export function regularLatinFace(css: string, family: string): CssFontFace | undefined {
  const faces = cssFontFaces(css).filter(face => face.family.toLowerCase() === family.toLowerCase() && face.style === 'normal' && face.latin);
  const regular = regularFile(faces.map((face, index) => ({ index, style: 'normal' as const, weight: face.weight })));
  return regular && faces[regular.index];
}

// ── Fallback and preload (render version 15) ──────────────────────────────

const DIRECTORY = '/_typeroll/fonts/';
const usableMetrics = (metrics: SiteFontFile['metrics']) => !!metrics && metrics.units_per_em > 0 && metrics.x_width_avg > 0;

/**
 * Complete a frozen plan with what needs the copied files: each self-hosted
 * family's metric-matched fallback and the body family's preload. Uploaded
 * files carry their metrics; a Google family's are read from its upright
 * Latin file. A file that cannot be read only leaves its family without one.
 */
export function completeFontPlan(plan: FontPlan, copied: {
  css: string;
  /** Copied file bytes by name. */
  file: (name: string) => Uint8Array | undefined;
  library: Library;
  /** Same-origin name of each copied library file by id. */
  libraryNames: ReadonlyMap<string, string>;
  googleSelfHosted: boolean;
}): FontPlan {
  if (plan.render_version < FONT_PLAN_RENDER_VERSION) return plan;
  const byId = new Map(copied.library.map(file => [file.id, file]));
  let preload: string | undefined;
  for (const family of plan.families) {
    const kind = family.category === 'serif' ? 'serif' : 'sans';
    if (family.source === 'upload') {
      const files = (family.files ?? []).flatMap(id => byId.has(id) && copied.libraryNames.has(id) ? [byId.get(id)!] : []);
      const regular = regularFile(files);
      const measured = [regular, ...files].find(file => usableMetrics(file?.metrics));
      if (measured) family.fallback = fallbackOverrides(measured.metrics!, measured.category === 'serif' ? 'serif' : kind);
      if (regular && family.roles.includes('body')) preload = `${DIRECTORY}${copied.libraryNames.get(regular.id)}`;
    } else if (family.source === 'google' && copied.googleSelfHosted) {
      const face = regularLatinFace(copied.css, family.family);
      if (!face?.url.startsWith(DIRECTORY)) continue;
      const bytes = copied.file(face.url.slice(DIRECTORY.length));
      if (!bytes) continue;
      try { family.fallback = fallbackOverrides(readFontFile(bytes, FONT_CODECS).metrics, kind); } catch { /* no fallback for an unreadable file */ }
      if (family.roles.includes('body') && face.url.endsWith('.woff2')) preload = face.url;
    }
  }
  if (preload) plan.preload = preload;
  return plan;
}
