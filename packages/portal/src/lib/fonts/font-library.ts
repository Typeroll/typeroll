// The site's Fonts library: uploaded font files at paths.font(org, site, id),
// with their bytes in private storage (./font-storage.ts).
//
// An upload is read with readFontFile; a TTF, OTF or WOFF file is converted
// to WOFF2 (encodeWoff2) and its original kept. Family, weight and style
// default from the file and may be corrected by the uploader. The uploader
// must confirm that the licence allows use on the website; that confirmation
// is stored with who gave it and when. Font files belong to the site, not to
// a version, like media.
//
// `listSiteFonts` and `readSiteFontBytes` are also the publication's contract:
// a publication copies the files the font plan names while it is frozen.

import {
  catalogFont, encodeWoff2, FAMILY_PATTERN, FONT_WEIGHTS, FontFileError, fontRoleFamilies, isSystemFont, MAIN_VERSION_ID,
  MAX_FONT_UPLOAD_BYTES, MAX_SITE_FONT_FILES, paths, readFontFile, SITE_FONT_ROLES, searchFontCatalog,
  type CatalogFont, type FontFileInfo, type FontSearchFilters, type FontService, type SiteFontFile, type SiteFontRole, type SiteSettings,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { vstore } from '../version-store';
import { ConnectionError } from '../publishing/connections';
import { brotliCompress, FONT_CODECS } from './codecs';
import { deleteFontObjects, fontStorageDestination, getFontObject, putFontObject, sha256Hex, type FontStorage } from './font-storage';

export type FontErrorCode =
  | 'font_unsupported' | 'font_invalid' | 'font_collection' | 'font_too_large' | 'font_licence_required'
  | 'font_duplicate' | 'font_library_full' | 'font_details_invalid' | 'font_not_found' | 'font_source_unavailable';

export class FontLibraryError extends Error {
  constructor(message: string, readonly status: number, readonly code: FontErrorCode | string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/** A refused request as `{ status, body: { error, code } }`, or null for an unexpected error. */
export function fontFailureBody(error: unknown): { status: number; body: { error: string; code?: string; details?: Record<string, unknown> } } | null {
  if (error instanceof FontLibraryError) return { status: error.status, body: { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) } };
  if (error instanceof ConnectionError) return { status: error.status, body: { error: error.message, code: error.code ?? 'font_storage_unavailable' } };
  return null;
}

/** The stored document: the public shape plus where its bytes are. */
type StoredSiteFont = SiteFontFile & { storage: FontStorage };

const publicFont = (font: SiteFontFile): SiteFontFile => {
  const { storage: _storage, ...rest } = font as StoredSiteFont;
  return rest;
};
const byAge = (a: SiteFontFile, b: SiteFontFile) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

async function listStoredFonts(orgId: string, siteId: string): Promise<StoredSiteFont[]> {
  return (await getStore().listDocs<StoredSiteFont>(paths.fonts(orgId, siteId))).sort(byAge);
}

/** Every file in the site's Fonts library, oldest first. */
export async function listSiteFonts(orgId: string, siteId: string): Promise<SiteFontFile[]> {
  return (await listStoredFonts(orgId, siteId)).map(publicFont);
}

/** One library file, or null. */
export async function readSiteFont(orgId: string, siteId: string, fontId: string): Promise<SiteFontFile | null> {
  const font = await getStore().getDoc<StoredSiteFont>(paths.font(orgId, siteId, fontId));
  return font ? publicFont(font) : null;
}

/** The bytes of a library file: the served WOFF2 (`file`) or the uploaded original. Verifies the sha256. */
export async function readSiteFontBytes(orgId: string, siteId: string, font: SiteFontFile, which: 'file' | 'original' = 'file'): Promise<Uint8Array> {
  const stored = await getStore().getDoc<StoredSiteFont>(paths.font(orgId, siteId, font.id));
  if (!stored) throw new Error(`Font ${font.id} is no longer in the site's Fonts library`);
  const entry = which === 'original' ? font.original : font.file;
  if (!entry) throw new Error(`Font ${font.id} has no ${which} file`);
  const bytes = await getFontObject(orgId, siteId, font.id, stored.storage ?? { provider: 'datastore' }, entry.key);
  if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) throw new Error(`Font ${font.id} (${which}) failed integrity verification`);
  return bytes;
}

// ── Reading uploads ───────────────────────────────────────────────────────

/** Read an upload's name, style, axes and metrics; refuses anything that is not a single font. */
export function inspectFontBytes(bytes: Uint8Array): FontFileInfo {
  if (bytes.byteLength > MAX_FONT_UPLOAD_BYTES) throw new FontLibraryError(`The font file is larger than ${MAX_FONT_UPLOAD_BYTES / 1024 / 1024} MB`, 413, 'font_too_large');
  try {
    return readFontFile(bytes, FONT_CODECS);
  } catch (error) {
    if (error instanceof FontFileError) throw new FontLibraryError(error.message, error.code === 'font_unsupported' ? 415 : 422, error.code);
    throw new FontLibraryError('The font file could not be read', 422, 'font_invalid');
  }
}

const detailsError = (message: string) => new FontLibraryError(message, 400, 'font_details_invalid');
const snapWeight = (value: number) => Math.min(900, Math.max(100, Math.round(value / 100) * 100));

/** The weight range a variable file covers in steps of 100, or null for a static file. */
function variableRange(info: FontFileInfo): [number, number] | null {
  const axis = info.variable?.wght;
  if (!axis) return null;
  const low = Math.min(900, Math.max(100, Math.ceil(axis[0] / 100) * 100)), high = Math.max(100, Math.min(900, Math.floor(axis[1] / 100) * 100));
  return high > low ? [low, high] : null;
}

/** A weight as typed: 400, "400", "100-900", "100..900" or [100, 900]. Undefined when absent. */
export function parseFontWeight(value: unknown): number | [number, number] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value) && value.length === 2) return [Number(value[0]), Number(value[1])];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const range = /^\s*(\d{3})\s*(?:-|–|\.\.)\s*(\d{3})\s*$/.exec(value);
    if (range) return [Number(range[1]), Number(range[2])];
    if (/^\s*\d{3}\s*$/.test(value)) return Number(value);
  }
  throw detailsError('weight must be a weight from 100 to 900 in steps of 100 ("400"), or a range such as "100-900" for a variable font');
}

const isStepWeight = (value: number) => (FONT_WEIGHTS as readonly number[]).includes(value);

function checkWeight(weight: number | [number, number], info: FontFileInfo): number | [number, number] {
  const range = variableRange(info);
  if (Array.isArray(weight)) {
    const [low, high] = weight;
    if (!range) throw detailsError('A weight range needs a variable font; this file has one weight. Give a single weight such as "400".');
    if (!isStepWeight(low) || !isStepWeight(high) || low >= high) throw detailsError('A weight range must be two weights from 100 to 900 in steps of 100, the lower first ("100-900")');
    if (low < range[0] || high > range[1]) throw detailsError(`This variable font covers weights ${range[0]}–${range[1]}`);
    return [low, high];
  }
  if (!isStepWeight(weight)) throw detailsError('weight must be from 100 to 900 in steps of 100');
  if (range && (weight < range[0] || weight > range[1])) throw detailsError(`This variable font covers weights ${range[0]}–${range[1]}`);
  return weight;
}

function checkFamily(value: unknown, fallback?: string): string {
  const family = (typeof value === 'string' && value.trim() ? value : fallback ?? '').trim().replace(/\s+/g, ' ');
  if (!FAMILY_PATTERN.test(family)) {
    throw detailsError(value === undefined || value === ''
      ? `The file's family name "${fallback ?? ''}" cannot be used as it is; give a family name (letters, digits and spaces, at most 80 characters)`
      : 'family must be a font family name (letters, digits and spaces, at most 80 characters)');
  }
  return family;
}

function checkStyle(value: unknown): 'normal' | 'italic' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'normal' || value === 'italic') return value;
  throw detailsError('style must be "normal" or "italic"');
}

function checkCategory(value: unknown): 'sans' | 'serif' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'sans' || value === 'serif') return value;
  throw detailsError('category must be "sans" or "serif" (it chooses the metric-matched fallback: Arial or Times New Roman)');
}

function checkNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 500) throw detailsError('licence_note must be text up to 500 characters');
  return value.trim() || undefined;
}

/** Serif only when the name says so; everything else falls back on a sans-serif face. */
const guessCategory = (family: string): 'sans' | 'serif' => /serif/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans';

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || undefined;

export interface FontUploadInput {
  bytes: Uint8Array;
  filename?: string;
  family?: unknown;
  weight?: unknown;
  style?: unknown;
  category?: unknown;
  licence_confirmed?: unknown;
  licence_note?: unknown;
  /** Who confirmed the licence: the person's email or `api-key:<prefix>`. */
  by: string;
}

/** Add an uploaded font file to the site's library. */
export async function addSiteFont(orgId: string, siteId: string, input: FontUploadInput): Promise<SiteFontFile> {
  if (input.licence_confirmed !== true && input.licence_confirmed !== 'true') {
    throw new FontLibraryError('Confirm that the font\'s licence allows use on this website (licence_confirmed: true). Most desktop licences do not include web use.', 400, 'font_licence_required');
  }
  const info = inspectFontBytes(input.bytes);
  const family = checkFamily(input.family, info.family);
  const parsedWeight = parseFontWeight(input.weight);
  const range = variableRange(info);
  const weight = checkWeight(parsedWeight ?? range ?? snapWeight(info.weight), info);
  const style = checkStyle(input.style) ?? (info.italic ? 'italic' : 'normal');
  const category = checkCategory(input.category) ?? guessCategory(family);
  const note = checkNote(input.licence_note);

  const converted = info.format !== 'woff2';
  const served = converted ? encodeWoff2(input.bytes, brotliCompress, FONT_CODECS) : input.bytes;
  if (converted) inspectFontBytes(served);
  const uploadSha = sha256Hex(input.bytes), servedSha = sha256Hex(served);

  const existing = await listStoredFonts(orgId, siteId);
  const duplicate = existing.find(font => [font.file.sha256, font.original?.sha256].some(sha => sha === uploadSha || sha === servedSha));
  if (duplicate) throw new FontLibraryError(`This file is already in the Fonts library (${duplicate.family}, id ${duplicate.id})`, 409, 'font_duplicate', { font_id: duplicate.id });
  if (existing.length >= MAX_SITE_FONT_FILES) throw new FontLibraryError(`The Fonts library holds at most ${MAX_SITE_FONT_FILES} files; delete one first`, 409, 'font_library_full');

  const storage = await fontStorageDestination(orgId);
  const prefix = await siteMediaPrefix(orgId, siteId);
  // The id follows the uploaded bytes, so the same file cannot be added twice at once.
  const id = uploadSha.slice(0, 24);
  const file: SiteFontFile['file'] = { format: 'woff2', bytes: served.byteLength, sha256: servedSha, key: `private/${prefix}/fonts/${servedSha}.woff2` };
  const original: SiteFontFile['original'] = converted ? {
    format: info.format as 'ttf' | 'otf' | 'woff', bytes: input.bytes.byteLength, sha256: uploadSha,
    key: `private/${prefix}/fonts/originals/${uploadSha}.${info.format}`,
    ...(input.filename && safeName(input.filename) ? { name: safeName(input.filename) } : {}),
  } : undefined;
  await putFontObject(orgId, siteId, id, storage, file.key, served, 'font/woff2');
  if (original) await putFontObject(orgId, siteId, id, storage, original.key, input.bytes, `font/${info.format === 'otf' ? 'otf' : info.format === 'woff' ? 'woff' : 'ttf'}`);

  const now = new Date().toISOString();
  const font: StoredSiteFont = {
    id, family, weight, style, file, ...(original ? { original } : {}), metrics: info.metrics, category,
    licence: { confirmed: true, by: input.by, at: now, ...(note ? { note } : {}) },
    created_at: now, storage,
  };
  const { id: _id, ...doc } = font;
  const created = await getStore().createDocIfMissing(paths.font(orgId, siteId, id), doc as unknown as Record<string, unknown>);
  if (!created) throw new FontLibraryError('This file is already in the Fonts library', 409, 'font_duplicate', { font_id: id });
  return publicFont(font);
}

export interface FontPatchInput { family?: unknown; weight?: unknown; style?: unknown; category?: unknown; licence_note?: unknown }

/** Correct a library file's family, weight, style, category or licence note. */
export async function updateSiteFont(orgId: string, siteId: string, fontId: string, patch: FontPatchInput): Promise<SiteFontFile> {
  const allowed = ['family', 'weight', 'style', 'category', 'licence_note'];
  const unknown = Object.keys(patch).filter(key => !allowed.includes(key));
  if (unknown.length) throw detailsError(`Unknown fields: ${unknown.join(', ')}. Accepted: ${allowed.join(', ')}`);
  const path = paths.font(orgId, siteId, fontId);
  const font = await getStore().getDoc<StoredSiteFont>(path);
  if (!font) throw new FontLibraryError('Font not found', 404, 'font_not_found');
  const update: Partial<StoredSiteFont> = {};
  if (patch.family !== undefined) update.family = checkFamily(patch.family);
  if (patch.weight !== undefined) {
    const weight = parseFontWeight(patch.weight);
    if (weight === undefined) throw detailsError('weight cannot be empty');
    // The axis range is in the file; read it rather than trust the stored weight.
    update.weight = checkWeight(weight, inspectFontBytes(await readSiteFontBytes(orgId, siteId, publicFont(font))));
  }
  const style = checkStyle(patch.style);
  if (style) update.style = style;
  const category = checkCategory(patch.category);
  if (category) update.category = category;
  if (patch.licence_note !== undefined) {
    const note = checkNote(patch.licence_note);
    const { note: _old, ...licence } = font.licence;
    update.licence = { ...licence, ...(note ? { note } : {}) };
  }
  if (!Object.keys(update).length) return publicFont(font);
  const { id: _id, ...current } = font;
  const next = { ...current, ...update };
  if (!(await getStore().compareAndReplaceDoc(path, font as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>))) {
    throw new FontLibraryError('The font changed while saving; try again', 409, 'font_conflict');
  }
  return publicFont({ ...next, id: fontId } as StoredSiteFont);
}

/**
 * Remove a library file and its stored bytes. Allowed while a role uses the
 * family: the response names the roles, which fall back to the next source
 * (a font service, Google Fonts, or the fallback stack) at the next publication.
 */
export async function deleteSiteFont(orgId: string, siteId: string, fontId: string): Promise<{ deleted: true; warning?: string }> {
  const path = paths.font(orgId, siteId, fontId);
  const fonts = await listStoredFonts(orgId, siteId);
  const font = fonts.find(candidate => candidate.id === fontId);
  if (!font) throw new FontLibraryError('Font not found', 404, 'font_not_found');
  await getStore().deleteTree(path);
  // Keys are content addressed; keep any object another file still points at.
  const others = new Set(fonts.filter(other => other.id !== fontId).flatMap(other => [other.file.key, other.original?.key]));
  const keys = [font.file.key, font.original?.key].filter((key): key is string => !!key && !others.has(key));
  await deleteFontObjects(orgId, font.storage ?? { provider: 'datastore' }, keys);
  const familyLeft = fonts.some(other => other.id !== fontId && other.family.toLowerCase() === font.family.toLowerCase());
  const roles = familyLeft ? [] : rolesUsing(font.family, await mainFonts(orgId, siteId));
  return { deleted: true, ...(roles.length ? { warning: `${font.family} is still chosen for ${roles.join(', ')}. Without its files ${roles.length > 1 ? 'these roles fall' : 'this role falls'} back to Google Fonts or the fallback stack at the next publication; choose another family in Settings → Design.` } : {}) };
}

// ── Where the families are used ──────────────────────────────────────────

type FontSettings = SiteSettings['fonts'] | undefined;

async function mainFonts(orgId: string, siteId: string): Promise<FontSettings> {
  return ((await vstore.settings(orgId, siteId, MAIN_VERSION_ID)) as SiteSettings | null)?.fonts;
}

function rolesUsing(family: string, fonts: FontSettings): SiteFontRole[] {
  const families = fontRoleFamilies(fonts);
  const key = family.trim().toLowerCase();
  return SITE_FONT_ROLES.filter(role => families[role]?.trim().toLowerCase() === key);
}

/** Every library family with the roles that use it in the site's main settings. */
export function fontUsedBy(library: readonly SiteFontFile[], fonts: FontSettings): Record<string, SiteFontRole[]> {
  const out: Record<string, SiteFontRole[]> = {};
  for (const font of library) if (!(font.family in out)) out[font.family] = rolesUsing(font.family, fonts);
  return out;
}

/** The library and where its families are used (the GET routes' body). */
export async function siteFontsResponse(orgId: string, siteId: string): Promise<{ fonts: SiteFontFile[]; used_by: Record<string, SiteFontRole[]> }> {
  const [fonts, settings] = await Promise.all([listSiteFonts(orgId, siteId), mainFonts(orgId, siteId)]);
  return { fonts, used_by: fontUsedBy(fonts, settings) };
}

/**
 * Warnings for role families the site cannot load from the catalog, its
 * Fonts library, a font service or the system stack: they are requested from
 * Google Fonts by name and fall back when Google does not have them.
 */
export function fontSettingsWarnings(fonts: FontSettings, library: readonly Pick<SiteFontFile, 'family'>[]): string[] {
  if (!fonts) return [];
  const uploaded = new Set(library.map(font => font.family.toLowerCase()));
  const services = new Set((Array.isArray(fonts.services) ? fonts.services : []).flatMap((service: FontService) => service.families ?? []).map(name => name.toLowerCase()));
  const warnings: string[] = [];
  for (const role of SITE_FONT_ROLES) {
    const family = (fonts as Record<string, unknown>)[role];
    if (typeof family !== 'string' || !family.trim() || isSystemFont(family)) continue;
    const key = family.trim().toLowerCase();
    if (catalogFont(family) || uploaded.has(key) || services.has(key)) continue;
    warnings.push(`fonts.${role} "${family}" is not in the font catalog, the site's Fonts library or a font service. It is requested from Google Fonts by name and shows in the fallback font if Google does not have it. Choose a catalog family (search_fonts), upload the font to the Fonts library, or add its font service.`);
  }
  return warnings;
}

// ── Catalog search ───────────────────────────────────────────────────────

export interface FontCatalogResponse {
  fonts: Array<CatalogFont & { source: 'google' }>;
  library: Array<{ family: string; source: 'upload'; weights: Array<number | [number, number]>; italic: boolean }>;
  services: Array<{ family: string; source: 'service'; provider: FontService['provider'] }>;
}

const matchesQuery = (family: string, query: string) => !query || family.toLowerCase().includes(query);

/** Catalog families plus the site's own uploaded and service families matching the same query. */
export async function fontCatalogResponse(orgId: string, siteId: string, filters: FontSearchFilters): Promise<FontCatalogResponse> {
  const query = (filters.query ?? '').trim().toLowerCase();
  const [library, settings] = await Promise.all([listSiteFonts(orgId, siteId), mainFonts(orgId, siteId)]);
  const families = new Map<string, FontCatalogResponse['library'][number]>();
  for (const font of library) {
    if (!matchesQuery(font.family, query)) continue;
    const entry = families.get(font.family.toLowerCase()) ?? { family: font.family, source: 'upload' as const, weights: [], italic: false };
    if (font.style === 'italic') entry.italic = true;
    else entry.weights.push(font.weight);
    families.set(font.family.toLowerCase(), entry);
  }
  const services: FontCatalogResponse['services'] = [];
  for (const service of Array.isArray(settings?.services) ? settings!.services : []) {
    for (const family of service.families ?? []) if (matchesQuery(family, query)) services.push({ family, source: 'service', provider: service.provider });
  }
  return { fonts: searchFontCatalog(filters).map(font => ({ ...font, source: 'google' as const })), library: [...families.values()], services };
}

/** Parse the catalog query string. */
export function fontSearchFilters(params: URLSearchParams): FontSearchFilters {
  const flag = (name: string) => { const value = params.get(name); return value === null ? undefined : /^(1|true|yes)$/i.test(value); };
  const categories = (params.get('category') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const valid = ['sans', 'serif', 'display', 'handwriting', 'mono'];
  const bad = categories.filter(value => !valid.includes(value));
  if (bad.length) throw detailsError(`category must be one or more of ${valid.join(', ')}`);
  const limit = params.get('limit');
  const parsedLimit = limit === null || limit === '' ? undefined : Number(limit);
  if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 250)) throw detailsError('limit must be an integer from 1 to 250');
  return {
    query: params.get('query') ?? undefined,
    ...(categories.length ? { category: categories as CatalogFont['category'][] } : {}),
    variable: flag('variable'), italic: flag('italic'), latin_ext: flag('latin_ext'),
    ...(parsedLimit ? { limit: parsedLimit } : {}),
  };
}

