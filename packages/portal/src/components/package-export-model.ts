// Pure helpers behind the package export on the Packages page: the draft
// (what to include and the package's details), its problems, the request
// body and the download's file name. PackageExport.tsx stays thin around
// these.

import { SITE_PACKAGE_EXTENSION } from '@typeroll/shared';

/** What the site can export, from GET /packages/exportable. */
export interface Exportable {
  block_templates: Array<{ id: string; name: string; kind?: 'block' | 'section'; category?: string }>;
  page_templates: Array<{ id: string; name: string }>;
  global_blocks: Array<{ id: string; name: string }>;
  block_types: Array<{ id: string; label: string }>;
  styles: Array<{ id: string; name: string; role?: string }>;
  font_families: Array<{ family: string; source: 'upload' | 'catalog' | 'service' }>;
  media: Array<{ id: string; filename: string; url: string; demo?: boolean }>;
}

export type ExportKind = 'collection' | 'site';
export type ExportSection = 'block_templates' | 'page_templates' | 'global_blocks' | 'block_types';

export const EXPORT_SECTIONS: ReadonlyArray<{ section: ExportSection; label: string; empty: string }> = [
  { section: 'block_templates', label: 'Block templates and sections', empty: 'No block templates yet. Save one from a block in the page editor.' },
  { section: 'page_templates', label: 'Page templates', empty: 'No page templates.' },
  { section: 'global_blocks', label: 'Global blocks', empty: 'No shared global blocks.' },
  { section: 'block_types', label: 'Block types', empty: 'No site block types.' },
];

export interface ExportMeta {
  name: string;
  id: string;
  /** Whether the id was typed; until then it follows the name. */
  idEdited: boolean;
  version: string;
  description: string;
  authorName: string;
  authorUrl: string;
  licenceName: string;
  licenceUrl: string;
  /** Comma-separated language codes. */
  languages: string;
}

export interface ExportDraft {
  kind: ExportKind;
  chosen: Record<ExportSection, string[]>;
  styles: 'used' | 'all';
  design: boolean;
  menus: boolean;
  siteFields: boolean;
  /** Uploaded font families whose files go in the package. */
  fonts: string[];
  fontsConfirmed: boolean;
  demoMedia: string[];
  meta: ExportMeta;
}

export function initialExportDraft(exportable: Exportable | null, language?: string): ExportDraft {
  return {
    kind: 'collection',
    chosen: { block_templates: [], page_templates: [], global_blocks: [], block_types: [] },
    styles: 'used',
    design: false,
    menus: false,
    siteFields: false,
    fonts: [],
    fontsConfirmed: false,
    demoMedia: (exportable?.media ?? []).filter(media => media.demo).map(media => media.id),
    meta: { name: '', id: '', idEdited: false, version: '1.0.0', description: '', authorName: '', authorUrl: '', licenceName: '', licenceUrl: '', languages: language ?? '' },
  };
}

/** A package id from its name: "Café Sections" → "cafe-sections". */
export function packageSlug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

/** Change the name; the id follows until it is typed. */
export function withName(meta: ExportMeta, name: string): ExportMeta {
  return { ...meta, name, id: meta.idEdited ? meta.id : packageSlug(name) };
}

/** The id items to send for a section: `all` when every item is chosen. */
export function sectionChoice(chosen: readonly string[], available: ReadonlyArray<{ id: string }>): string[] | 'all' | undefined {
  if (!chosen.length) return undefined;
  const ids = available.map(item => item.id).filter(id => chosen.includes(id));
  if (!ids.length) return undefined;
  return ids.length === available.length ? 'all' : ids;
}

export interface FontGroups { upload: string[]; catalog: string[]; service: string[] }

export function fontGroups(families: Exportable['font_families']): FontGroups {
  const groups: FontGroups = { upload: [], catalog: [], service: [] };
  for (const font of families) if (!groups[font.source].includes(font.family)) groups[font.source].push(font.family);
  for (const list of [groups.upload, groups.catalog, groups.service]) list.sort((a, b) => a.localeCompare(b));
  return groups;
}

/** Fonts travel with the design: a whole site, or a collection with its design tokens. */
export const fontsApply = (draft: Pick<ExportDraft, 'kind' | 'design'>) => draft.kind === 'site' || draft.design;

export type ExportField = 'name' | 'id' | 'version' | 'authorUrl' | 'licenceUrl' | 'languages' | 'entries' | 'fonts' | 'kind';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const isWebAddress = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; } };

export const languageList = (value: string) => value.split(/[\s,]+/).map(code => code.trim()).filter(Boolean);

/** What must change before the export can run, by field. */
export function exportProblems(draft: ExportDraft, exportable: Exportable | null, isAdmin: boolean): Partial<Record<ExportField, string>> {
  const problems: Partial<Record<ExportField, string>> = {};
  const meta = draft.meta;
  if (!meta.name.trim()) problems.name = 'Give the package a name.';
  else if (meta.name.trim().length > 120) problems.name = 'The name can be at most 120 characters.';
  if (!SLUG.test(meta.id)) problems.id = 'Use lowercase letters, digits, - and _ (starting with a letter or digit).';
  if (!meta.version.trim()) problems.version = 'Give it a version, such as 1.0.0.';
  else if (meta.version.trim().length > 32) problems.version = 'The version can be at most 32 characters.';
  if (meta.authorUrl.trim() && !isWebAddress(meta.authorUrl.trim())) problems.authorUrl = 'Enter a web address starting with https://.';
  if (meta.licenceUrl.trim() && !isWebAddress(meta.licenceUrl.trim())) problems.licenceUrl = 'Enter a web address starting with https://.';
  const badLanguage = languageList(meta.languages).find(code => !LANGUAGE.test(code));
  if (badLanguage) problems.languages = `“${badLanguage}” is not a language code such as en or sv.`;
  if (draft.kind === 'site' && !isAdmin) problems.kind = 'Only a site admin can export the whole site.';
  if (draft.kind === 'collection') {
    const any = EXPORT_SECTIONS.some(({ section }) => sectionChoice(draft.chosen[section], exportable?.[section] ?? []) !== undefined);
    if (!any && !draft.design && !draft.menus && !draft.siteFields && draft.styles !== 'all') problems.entries = 'Choose at least one entry to export.';
  }
  if (fontsApply(draft) && draft.fonts.length && !draft.fontsConfirmed) problems.fonts = 'Confirm that the licence allows passing these font files on, or leave them out.';
  return problems;
}

/** The POST /packages/export body. */
export function exportBody(draft: ExportDraft, exportable: Exportable | null): { selection: Record<string, unknown>; meta: Record<string, unknown> } {
  const selection: Record<string, unknown> = { kind: draft.kind };
  if (draft.kind === 'collection') {
    for (const { section } of EXPORT_SECTIONS) {
      const choice = sectionChoice(draft.chosen[section], exportable?.[section] ?? []);
      if (choice) selection[section] = choice;
    }
    selection.styles = draft.styles;
    if (draft.design) selection.design = true;
    if (draft.menus) selection.menus = 'all';
    if (draft.siteFields) selection.site_fields = true;
  } else {
    selection.styles = 'all';
    selection.design = true;
  }
  if (fontsApply(draft) && draft.fonts.length && draft.fontsConfirmed) selection.fonts = { families: [...draft.fonts], redistributable_confirmed: true };
  const known = new Set((exportable?.media ?? []).map(media => media.id));
  const demo = draft.demoMedia.filter(id => known.has(id));
  if (demo.length) selection.demo_media = demo;

  const m = draft.meta;
  const meta: Record<string, unknown> = { id: m.id, name: m.name.trim(), version: m.version.trim() };
  if (m.description.trim()) meta.description = m.description.trim();
  if (m.authorName.trim()) meta.author = { name: m.authorName.trim(), ...(m.authorUrl.trim() ? { url: m.authorUrl.trim() } : {}) };
  if (m.licenceName.trim()) meta.licence = { name: m.licenceName.trim(), ...(m.licenceUrl.trim() ? { url: m.licenceUrl.trim() } : {}) };
  const languages = languageList(m.languages);
  if (languages.length) meta.languages = languages;
  return { selection, meta };
}

/** The file name from Content-Disposition, else `<id>-<version>.typeroll`. */
export function downloadFilename(disposition: string | null | undefined, meta: Pick<ExportMeta, 'id' | 'version'>): string {
  const fallback = `${meta.id || 'package'}-${meta.version.trim().replace(/[^A-Za-z0-9._-]+/g, '-') || '1.0.0'}${SITE_PACKAGE_EXTENSION}`;
  if (!disposition) return fallback;
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (encoded) { try { return safeName(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))) || fallback; } catch { /* fall through */ } }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
  const name = plain ? (plain[2] ?? plain[1]).trim() : '';
  return safeName(name) || fallback;
}

const safeName = (name: string) => name.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim();
