// Pure helpers behind the font picker, the site's font settings and every
// font preview in the portal: picker sections over the catalog, the site's
// uploaded and service families, labels for role choices, and the
// stylesheets a preview loads.
//
// Previews only: published sites load their fonts from the publication's
// font plan, never from these URLs.

import {
  ADOBE_KIT_PATTERN, FAMILY_PATTERN, FONT_PLAN_RENDER_VERSION, MAX_FONT_SERVICES, SITE_FONT_ROLES, catalogFont, fontFamilyCss, fontFileWeightRange,
  fontRoleFamilies, fontSampleText, fontServiceProvider, fontServiceStylesheet, isSystemFont, matchFontWeight, searchFontCatalog,
  type CatalogFont, type FontService, type SiteFontFile, type SiteFontRole, type SiteSettings,
} from '@typeroll/shared';

export type SiteFonts = Partial<Pick<SiteSettings['fonts'], 'heading' | 'body' | 'mono' | 'display' | 'accent' | 'services'>>;
export type FontOptionSource = 'upload' | 'service' | 'system' | 'catalog' | 'custom';
type LibraryFile = Pick<SiteFontFile, 'id' | 'family' | 'weight' | 'style' | 'category'>;

/** One family the picker offers. `family` is the value written to the settings. */
export interface FontOption {
  family: string;
  source: FontOptionSource;
  category?: CatalogFont['category'];
  /** Weights the family has (a variable range lists its hundreds). */
  weights: number[];
  italic: boolean;
  variable?: [number, number];
  provider?: FontService['provider'];
}

export const SYSTEM_FAMILY = 'system';
export const ROLE_LABEL: Record<SiteFontRole, string> = { heading: 'Heading', body: 'Body', mono: 'Monospace', display: 'Display', accent: 'Accent' };
export const CATEGORY_LABEL: Record<CatalogFont['category'], string> = { sans: 'Sans serif', serif: 'Serif', display: 'Display', handwriting: 'Handwriting', mono: 'Monospace' };
export const PROVIDER_LABEL: Record<FontService['provider'], string> = { adobe: 'Adobe Fonts', bunny: 'Bunny Fonts', fontshare: 'Fontshare' };

const hundreds = ([min, max]: [number, number]) => {
  const out: number[] = [];
  for (let weight = Math.ceil(min / 100) * 100; weight <= max; weight += 100) out.push(weight);
  return out;
};
const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ── Options ───────────────────────────────────────────────────────────────

/** The site's uploaded families, one option per family. */
export function uploadedFontOptions(files: readonly LibraryFile[] | null | undefined): FontOption[] {
  const byFamily = new Map<string, LibraryFile[]>();
  for (const file of files ?? []) {
    const key = file.family.trim().toLowerCase();
    byFamily.set(key, [...byFamily.get(key) ?? [], file]);
  }
  return [...byFamily.values()].map((group): FontOption => {
    const ranges = group.map(file => fontFileWeightRange(file));
    const variable = group.filter(file => Array.isArray(file.weight)).map(file => file.weight as [number, number]);
    return {
      family: group[0]!.family,
      source: 'upload',
      category: group.find(file => file.category)?.category,
      weights: unique(ranges.flatMap(range => hundreds(range).length ? hundreds(range) : [range[0]])),
      italic: group.some(file => file.style === 'italic'),
      variable: variable.length ? [Math.min(...variable.map(r => r[0])), Math.max(...variable.map(r => r[1]))] : undefined,
    };
  }).sort((a, b) => a.family.localeCompare(b.family));
}

/** Families the site's font services define. Their weights are unknown until loaded. */
export function serviceFontOptions(services: readonly FontService[] | null | undefined): FontOption[] {
  const seen = new Set<string>();
  const out: FontOption[] = [];
  for (const service of services ?? []) for (const family of service.families ?? []) {
    if (seen.has(family.toLowerCase())) continue;
    seen.add(family.toLowerCase());
    out.push({ family, source: 'service', weights: [], italic: false, provider: service.provider });
  }
  return out;
}

export function catalogFontOption(font: CatalogFont): FontOption {
  return { family: font.family, source: 'catalog', category: font.category, weights: font.weights, italic: !!font.italic?.length, variable: font.variable };
}

export const SYSTEM_OPTION: FontOption = { family: SYSTEM_FAMILY, source: 'system', weights: [400, 700], italic: true };

/** What the current value is: an uploaded, service, system, catalog or other Google family. */
export function describeFontValue(family: string, uploads?: readonly LibraryFile[] | null, services?: readonly FontService[] | null): FontOption {
  const name = family.trim();
  if (isSystemFont(name)) return SYSTEM_OPTION;
  const upload = uploadedFontOptions(uploads).find(option => sameName(option.family, name));
  if (upload) return upload;
  const service = serviceFontOptions(services).find(option => sameName(option.family, name));
  if (service) return service;
  const catalog = catalogFont(name);
  if (catalog) return catalogFontOption(catalog);
  return { family: name, source: 'custom', weights: [], italic: false };
}

/** Meta line for an option: category, weights, variable, italic. */
export function describeWeights(option: FontOption): string {
  const parts: string[] = [];
  if (option.source === 'system') return 'The visitor’s device font, no download';
  if (option.source === 'service') return `${PROVIDER_LABEL[option.provider ?? 'adobe']}, loads from its CDN`;
  if (option.source === 'custom') return 'Google Fonts family by name, not in the catalog';
  if (option.category) parts.push(CATEGORY_LABEL[option.category]);
  if (option.variable) parts.push(`weights ${option.variable[0]}–${option.variable[1]}`, 'variable');
  else if (option.weights.length === 1) parts.push(`weight ${option.weights[0]}`);
  else if (option.weights.length) parts.push(`weights ${option.weights.join(', ')}`);
  if (option.italic) parts.push('italic');
  if (option.source === 'upload') parts.push('your font');
  return parts.join(' · ');
}

// ── Sections ──────────────────────────────────────────────────────────────

export interface FontPickerFilters {
  category?: CatalogFont['category'] | '';
  variable?: boolean;
  italic?: boolean;
  latin_ext?: boolean;
}

export interface FontPickerSection {
  id: 'uploads' | 'services' | 'system' | 'catalog' | 'custom';
  label: string;
  options: FontOption[];
}

const matchesQuery = (family: string, query: string) => !query || family.toLowerCase().includes(query);
// The extended Latin filter does not hide uploads: their character sets are not known here.
const matchesFilters = (option: FontOption, filters: FontPickerFilters) =>
  (!filters.category || option.category === filters.category)
  && (!filters.variable || !!option.variable)
  && (!filters.italic || option.italic);

/**
 * The picker's sections for a query and filters: the site's own fonts first,
 * then its font services, the system font, the catalog, and a family typed by
 * name that is none of these.
 */
export function fontPickerSections(input: {
  query?: string;
  filters?: FontPickerFilters;
  uploads?: readonly LibraryFile[] | null;
  services?: readonly FontService[] | null;
  limit?: number;
}): FontPickerSection[] {
  const query = (input.query ?? '').trim().toLowerCase();
  const filters = input.filters ?? {};
  const filtered = !!(filters.category || filters.variable || filters.italic || filters.latin_ext);
  const sections: FontPickerSection[] = [];
  const uploads = uploadedFontOptions(input.uploads).filter(option => matchesQuery(option.family, query) && matchesFilters(option, filters));
  if (uploads.length) sections.push({ id: 'uploads', label: 'Your fonts', options: uploads });
  // Service families have no category or weights the picker knows of.
  const services = filtered ? [] : serviceFontOptions(input.services).filter(option => matchesQuery(option.family, query));
  if (services.length) sections.push({ id: 'services', label: 'Font services', options: services });
  if (!filtered && (!query || 'system'.startsWith(query) || 'system font'.includes(query))) sections.push({ id: 'system', label: 'System', options: [SYSTEM_OPTION] });
  const catalog = searchFontCatalog({
    query, category: filters.category || undefined, variable: filters.variable || undefined, italic: filters.italic || undefined,
    latin_ext: filters.latin_ext || undefined, limit: input.limit ?? 250,
  }).map(catalogFontOption);
  if (catalog.length) sections.push({ id: 'catalog', label: 'Catalog', options: catalog });
  const typed = (input.query ?? '').trim();
  const known = sections.some(section => section.options.some(option => sameName(option.family, typed)));
  if (typed && !known && FAMILY_PATTERN.test(typed) && !isSystemFont(typed)) {
    sections.push({ id: 'custom', label: 'Another Google Fonts family', options: [{ family: typed, source: 'custom', weights: [], italic: false }] });
  }
  return sections;
}

/** Options in keyboard order. */
export const flatOptions = (sections: readonly FontPickerSection[]) => sections.flatMap(section => section.options);

/** The next active index for a key, or null when the key does not move. */
export function moveActive(key: string, index: number, count: number): number | null {
  if (!count) return null;
  if (key === 'ArrowDown') return index < 0 ? 0 : Math.min(count - 1, index + 1);
  if (key === 'ArrowUp') return index <= 0 ? 0 : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'PageDown') return Math.min(count - 1, Math.max(0, index) + 8);
  if (key === 'PageUp') return Math.max(0, index - 8);
  return null;
}

// ── Role labels ───────────────────────────────────────────────────────────

const familyLabel = (family: string | undefined) => !family ? '' : isSystemFont(family) ? 'system font' : family;

/** The family each role uses, with display and accent available only from render version 15. */
export function effectiveRoleFamilies(fonts: SiteFonts | null | undefined, renderVersion: number | null = null) {
  const families = fontRoleFamilies(fonts ?? undefined);
  if (renderVersion !== null && renderVersion < FONT_PLAN_RENDER_VERSION) return { ...families, display: families.heading, accent: families.body };
  return families;
}

/**
 * The label of a role choice with the site's family, e.g. "Heading — Playfair
 * Display" or "Display — same as heading". Without the site's fonts the label
 * is the role alone.
 */
export function roleOptionLabel(role: string, fonts?: SiteFonts | null, renderVersion: number | null = null): string {
  if (role === 'inherit') return 'Inherit';
  if (!(SITE_FONT_ROLES as readonly string[]).includes(role)) return role;
  const name = ROLE_LABEL[role as SiteFontRole];
  const before15 = renderVersion !== null && renderVersion < FONT_PLAN_RENDER_VERSION;
  if (!fonts) return (role === 'display' || role === 'accent') && renderVersion === null ? `${name} (render version 15)` : name;
  const families = fontRoleFamilies(fonts);
  if (role === 'mono') return `${name} — ${fonts.mono ? familyLabel(fonts.mono) : 'system monospace'}`;
  if (role === 'display' || role === 'accent') {
    const fallback = role === 'display' ? 'heading' : 'body';
    const own = role === 'display' ? fonts.display : fonts.accent;
    if (before15) return `${name} — same as ${fallback} until render version 15`;
    return own ? `${name} — ${familyLabel(own)}` : `${name} — same as ${fallback}`;
  }
  return `${name} — ${familyLabel(families[role as 'heading' | 'body'])}`;
}

export interface RoleChoice { value: string; label: string }

/**
 * Choices for a font role select (a style's font, a block's `font` field).
 * Display and accent are left out below render version 15 unless already chosen.
 */
export function fontRoleChoices(options: readonly string[], fonts: SiteFonts | null | undefined, renderVersion: number | null, current?: string): RoleChoice[] {
  return options
    .filter(option => renderVersion === null || renderVersion >= FONT_PLAN_RENDER_VERSION || (option !== 'display' && option !== 'accent') || option === current)
    .map(option => ({ value: option, label: roleOptionLabel(option, fonts, renderVersion) }));
}

/** A select field that chooses a font role (`font`, `title_font`, …). */
export function isFontRoleField(field: { type: string; name: string; options?: readonly string[] }): boolean {
  if (field.type !== 'select' || !(field.name === 'font' || field.name.endsWith('_font'))) return false;
  const options = field.options ?? [];
  return options.length > 0 && options.every(option => option === 'inherit' || (SITE_FONT_ROLES as readonly string[]).includes(option));
}

// ── Preview stylesheets ───────────────────────────────────────────────────

/** Every character of the samples, both cases, for Google's `text=` subsetting. */
export function sampleCharacters(language: string | undefined): string {
  const sample = fontSampleText(language);
  const text = `${sample.heading} ${sample.body}`;
  return [...new Set([...`${text}${text.toUpperCase()}${text.toLowerCase()}`])].filter(char => char.trim()).sort().join('');
}

/** A CSS font-family stack for previewing a family. */
export function previewFontStack(family: string | undefined, category?: CatalogFont['category']): string {
  if (!family) return 'inherit';
  const fallback = category === 'serif' ? 'Georgia, serif' : category === 'mono' ? 'ui-monospace, monospace' : 'system-ui, sans-serif';
  return isSystemFont(family) ? fontFamilyCss(family) : `${fontFamilyCss(family)}, ${fallback}`;
}

/** The weights a preview loads for a catalog family: the nearest to 400 and 700. */
export function previewWeights(option: Pick<FontOption, 'weights'>): number[] {
  if (!option.weights.length) return [];
  return unique([matchFontWeight(400, option.weights)!, matchFontWeight(700, option.weights)!]);
}

/**
 * The Google Fonts stylesheet that previews one family. With `text`, Google
 * returns only those characters, so a list of previews stays tiny.
 */
export function googlePreviewUrl(family: string, options: { text?: string; weights?: number[] } = {}): string {
  const weights = options.weights?.length ? `:wght@${options.weights.join(';')}` : '';
  const text = options.text ? `&text=${encodeURIComponent(options.text)}` : '';
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family.trim()).replace(/%20/g, '+')}${weights}${text}&display=swap`;
}

/** The stylesheet a family's preview needs, or null (system and uploaded families need none). */
export function previewStylesheet(family: string, context: { uploads?: readonly LibraryFile[] | null; services?: readonly FontService[] | null; text?: string }): string | null {
  const option = describeFontValue(family, context.uploads, context.services);
  if (option.source === 'system' || option.source === 'upload') return null;
  if (option.source === 'service') {
    const service = (context.services ?? []).find(candidate => candidate.families.some(name => sameName(name, family)));
    return service ? fontServiceStylesheet(service) : null;
  }
  return googlePreviewUrl(option.family, { text: context.text, weights: option.source === 'catalog' ? previewWeights(option) : undefined });
}

const cssString = (value: string) => `'${value.replace(/[\\'\r\n<>;{}]/g, '')}'`;

/** The URL the portal serves a library file at (same-origin, signed-in). */
export const fontFileUrl = (siteId: string, fontId: string) => `/api/sites/${encodeURIComponent(siteId)}/fonts/${encodeURIComponent(fontId)}/file`;

/** `@font-face` rules for library files. `src` returns each file's URL (a data URL in a sandboxed frame), or null to leave it out. */
export function uploadFontFaceCss(files: readonly LibraryFile[], src: (file: LibraryFile) => string | null): string {
  return files.map(file => {
    const url = src(file);
    if (!url) return '';
    const [min, max] = fontFileWeightRange(file);
    return `@font-face{font-family:${cssString(file.family)};src:url("${url.replace(/["\\\n]/g, '')}") format("woff2");font-weight:${min === max ? min : `${min} ${max}`};font-style:${file.style === 'italic' ? 'italic' : 'normal'};font-display:swap}`;
  }).join('');
}

/** The role families a site sets explicitly that need loading (no system fonts, no fallbacks). */
export function siteFamiliesToLoad(fonts: SiteFonts | null | undefined): string[] {
  const families = fontRoleFamilies(fonts ?? undefined);
  const names = [families.heading, families.body, fonts?.mono, fonts?.display, fonts?.accent].filter((name): name is string => !!name && !isSystemFont(name));
  const out: string[] = [];
  for (const name of names) if (!out.some(existing => sameName(existing, name))) out.push(name);
  return out;
}

export interface PreviewFontPlan {
  /** Stylesheets to link: Google families and service stylesheets. */
  stylesheets: string[];
  /** Library files of the site's families, for `@font-face`. */
  uploads: LibraryFile[];
}

/**
 * What a preview of the whole site's typography loads: each explicit role
 * family from the Google stylesheet, the site's font services, or its
 * uploads. `text` limits Google's response to the sample characters.
 */
export function sitePreviewFonts(fonts: SiteFonts | null | undefined, library: readonly LibraryFile[] | null | undefined, options: { text?: string } = {}): PreviewFontPlan {
  const stylesheets: string[] = [];
  const uploads: LibraryFile[] = [];
  for (const family of siteFamiliesToLoad(fonts)) {
    const files = (library ?? []).filter(file => sameName(file.family, family));
    if (files.length) { uploads.push(...files); continue; }
    const href = previewStylesheet(family, { uploads: library, services: fonts?.services, text: options.text });
    if (href && !stylesheets.includes(href)) stylesheets.push(href);
  }
  // A service stylesheet loads once even when several roles use it.
  return { stylesheets, uploads };
}

const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** `<link>` and `<style>` markup for a sandboxed preview document. */
export function previewFontHead(plan: PreviewFontPlan, src: (file: LibraryFile) => string | null): string {
  const links = plan.stylesheets.map(href => `<link rel="stylesheet" href="${attribute(href)}">`).join('');
  const faces = uploadFontFaceCss(plan.uploads, src);
  return `${links}${faces ? `<style>${faces.replace(/</g, '\\3c ')}</style>` : ''}`;
}

/**
 * Sources a sandboxed font preview may load: Google's stylesheet and files,
 * the font services' CDNs, and uploaded files as data URLs (a sandboxed frame
 * has no origin, so it cannot send the portal's sign-in cookie).
 */
export const PREVIEW_FONT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://use.typekit.net https://p.typekit.net https://fonts.bunny.net https://api.fontshare.com",
  'font-src data: https://fonts.gstatic.com https://use.typekit.net https://fonts.bunny.net https://cdn.fontshare.com',
].join('; ');

// ── Font services ─────────────────────────────────────────────────────────

export type ServiceRequest = { provider: 'adobe'; kit: string } | { provider: 'bunny' | 'fontshare'; url: string };

/**
 * Read what was pasted into the font services field: an Adobe Fonts web
 * project ID (or its use.typekit.net stylesheet), or a Bunny Fonts or
 * Fontshare stylesheet URL.
 */
export function parseServiceInput(input: string): { request: ServiceRequest } | { error: string } {
  const value = input.trim();
  if (!value) return { error: 'Enter an Adobe Fonts web project ID or a stylesheet URL.' };
  const typekit = /^https:\/\/use\.typekit\.net\/([a-z0-9]+)\.css$/i.exec(value);
  const kit = (typekit?.[1] ?? value).toLowerCase();
  if (typekit || ADOBE_KIT_PATTERN.test(value)) {
    return ADOBE_KIT_PATTERN.test(kit) ? { request: { provider: 'adobe', kit } } : { error: 'An Adobe Fonts web project ID has 5–12 lowercase letters and digits.' };
  }
  const provider = fontServiceProvider(value);
  if (provider) return { request: { provider, url: value } };
  if (/^https?:\/\//i.test(value)) return { error: 'Use a stylesheet from https://fonts.bunny.net/css or https://api.fontshare.com/v2/css, or an Adobe Fonts web project ID.' };
  return { error: 'An Adobe Fonts web project ID has 5–12 lowercase letters and digits, such as abc1def.' };
}

export const serviceKey = (service: ServiceRequest | FontService) => service.provider === 'adobe' ? `adobe:${service.kit}` : `${service.provider}:${service.url}`;

/** Add a service, refusing duplicates and more than the allowed number. */
export function addService(services: readonly FontService[], service: FontService): { services: FontService[] } | { error: string } {
  if (services.some(existing => serviceKey(existing) === serviceKey(service))) return { error: 'This font service is already added.' };
  if (services.length >= MAX_FONT_SERVICES) return { error: `A site can use at most ${MAX_FONT_SERVICES} font services.` };
  return { services: [...services, service] };
}

/** The hidden `fonts.services` value: JSON, or empty to unset. */
export const serializeServices = (services: readonly FontService[]) => services.length ? JSON.stringify(services) : '';

export const serviceLabel = (service: FontService) => service.provider === 'adobe' ? `${PROVIDER_LABEL.adobe} — web project ${service.kit}` : `${PROVIDER_LABEL[service.provider]} — ${service.url}`;

/** Roles whose family a removed service defined, so the page can warn. */
export function rolesUsingFamilies(fonts: SiteFonts, families: readonly string[]): SiteFontRole[] {
  return SITE_FONT_ROLES.filter(role => {
    const family = fonts[role];
    return !!family && families.some(name => sameName(name, family));
  });
}

/** Read a `fonts.services` form value. */
export function parseServicesValue(value: string): FontService[] | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as FontService[] : undefined;
  } catch { return undefined; }
}
