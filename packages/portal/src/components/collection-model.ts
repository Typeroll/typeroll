// Pure helpers behind the organization collection: the entries as the
// collection API returns them, filtering by text and source, grouping by
// kind and category, the lines a card shows, what can be saved from a site
// and the request bodies. OrganizationCollection.tsx and the block editor's
// Collection section stay thin around these.

import type { CollectionEntryKind, CollectionEntrySource } from '@typeroll/shared';
import type { Exportable } from './package-export-model';
import type { ImportReport } from './package-import-model';

/** What GET /api/sites/{siteId}/collection returns for one entry. */
export interface CollectionEntryView {
  id: string;
  kind: CollectionEntryKind;
  name: string;
  description?: string;
  category?: string;
  preview_url?: string;
  languages?: string[];
  source: CollectionEntrySource;
  read_only?: boolean;
  updated_at: string;
  summary: CollectionEntrySummary;
}

export interface CollectionEntrySummary {
  block_count?: number;
  top_level_types?: string[];
  styles: number;
  block_types: number;
  media: number;
}

/** POST …/collection/{entryId}/insert. */
export interface CollectionInsertResult {
  /** A package import report; `renamed` lists `{ section, from, to }` (or is keyed by section). */
  report: ImportReport;
  page?: { id?: string; title?: string; blocks?: unknown[] } & Record<string, unknown>;
}

export const collectionApi = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}/collection`;
export const collectionPageHref = (siteId: string) => `/app/sites/${encodeURIComponent(siteId)}/collection`;

// ── Kinds ─────────────────────────────────────────────────────────────────

export const COLLECTION_KIND_ORDER: readonly CollectionEntryKind[] = ['section', 'block_template', 'global_block', 'page_template', 'block_type', 'package'];

export const COLLECTION_KIND_LABELS: Record<CollectionEntryKind, { one: string; many: string }> = {
  section: { one: 'Section', many: 'Sections' },
  block_template: { one: 'Block template', many: 'Block templates' },
  global_block: { one: 'Global block', many: 'Global blocks' },
  page_template: { one: 'Page template', many: 'Page templates' },
  block_type: { one: 'Block type', many: 'Block types' },
  package: { one: 'Package', many: 'Packages' },
};

/** Kinds that place blocks on a page; the rest are only added to the site. */
const PAGE_KINDS: ReadonlySet<CollectionEntryKind> = new Set(['section', 'block_template', 'global_block']);
export const canInsertIntoPage = (entry: Pick<CollectionEntryView, 'kind'>) => PAGE_KINDS.has(entry.kind);

/** The button that adds an entry to the site's own library. */
export function libraryActionLabel(kind: CollectionEntryKind): string {
  switch (kind) {
    case 'section': case 'block_template': return 'Add to this site’s templates';
    case 'global_block': return 'Add to this site’s global blocks';
    case 'page_template': return 'Add to this site’s page templates';
    case 'block_type': return 'Add to this site’s block types';
    case 'package': return 'Add to this site';
  }
}

/** Typeroll's built-ins and other read-only entries cannot be edited or deleted. */
export const isEditableEntry = (entry: Pick<CollectionEntryView, 'read_only' | 'source'>) => !entry.read_only && entry.source.type !== 'builtin';

// ── Sources ───────────────────────────────────────────────────────────────

export type SourceFilter = 'all' | 'organization' | 'typeroll' | 'apps' | 'packages';

export const SOURCE_FILTERS: ReadonlyArray<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'organization', label: 'Your organization' },
  { value: 'typeroll', label: 'Typeroll' },
  { value: 'apps', label: 'Apps' },
  { value: 'packages', label: 'Packages' },
];

export function sourceFilterOf(source: Pick<CollectionEntrySource, 'type'>): Exclude<SourceFilter, 'all'> {
  switch (source.type) {
    case 'builtin': return 'typeroll';
    case 'app': return 'apps';
    case 'package': return 'packages';
    default: return 'organization';
  }
}

/** Where an entry came from, in a few words. */
export function sourceLine(source: CollectionEntrySource, siteNames: Record<string, string> = {}): string {
  switch (source.type) {
    case 'builtin': return 'Typeroll built-in';
    case 'app': return source.publisher ? `From an app by ${source.publisher}` : 'From an app';
    case 'package': {
      const name = source.package_name ? `${source.package_name}${source.version ? ` ${source.version}` : ''}` : 'a package';
      return `From ${name}`;
    }
    default: {
      const site = source.site_id ? siteNames[source.site_id] : undefined;
      return site ? `Saved from ${site}` : 'Saved by your organization';
    }
  }
}

/** The publisher and whether its signature was verified, or null when there is none to show. */
export function publisherOf(source: CollectionEntrySource): { name: string; verified: boolean } | null {
  if (source.type === 'builtin') return { name: source.publisher ?? 'Typeroll', verified: true };
  if (!source.publisher) return null;
  return { name: source.publisher, verified: source.verified === true };
}

// ── Filtering and grouping ────────────────────────────────────────────────

export interface CollectionFilter { query: string; source: SourceFilter; kind?: CollectionEntryKind | 'all' }

export function filterEntries<T extends CollectionEntryView>(entries: readonly T[], filter: CollectionFilter): T[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if (filter.source !== 'all' && sourceFilterOf(entry.source) !== filter.source) return false;
    if (filter.kind && filter.kind !== 'all' && entry.kind !== filter.kind) return false;
    if (!words.length) return true;
    const text = [entry.name, entry.description, entry.category, entry.source.publisher, entry.source.package_name, COLLECTION_KIND_LABELS[entry.kind].one]
      .filter(Boolean).join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
}

export interface CollectionGroup<T> {
  kind: CollectionEntryKind;
  label: string;
  categories: Array<{ category: string | null; entries: T[] }>;
  count: number;
}

/** Entries by kind (in COLLECTION_KIND_ORDER), then by category (alphabetical, uncategorized last), then by name. */
export function groupEntries<T extends Pick<CollectionEntryView, 'kind' | 'category' | 'name'>>(entries: readonly T[]): Array<CollectionGroup<T>> {
  return COLLECTION_KIND_ORDER.flatMap(kind => {
    const ofKind = entries.filter(entry => entry.kind === kind);
    if (!ofKind.length) return [];
    const byCategory = new Map<string | null, T[]>();
    for (const entry of ofKind) {
      const key = entry.category?.trim() || null;
      byCategory.set(key, [...byCategory.get(key) ?? [], entry]);
    }
    const categories = [...byCategory.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
      .map(([category, list]) => ({ category, entries: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
    return [{ kind, label: COLLECTION_KIND_LABELS[kind].many, categories, count: ofKind.length }];
  });
}

/** The categories already used for a kind, for the category suggestions. */
export function knownCategories(entries: ReadonlyArray<Pick<CollectionEntryView, 'category'>>): string[] {
  return [...new Set(entries.map(entry => entry.category?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "4 blocks · 2 styles · 1 block type · 3 media files". */
export function summaryLine(summary: CollectionEntrySummary | undefined): string {
  if (!summary) return '';
  const parts: string[] = [];
  if (typeof summary.block_count === 'number') parts.push(plural(summary.block_count, 'block', 'blocks'));
  if (summary.styles) parts.push(plural(summary.styles, 'style', 'styles'));
  if (summary.block_types) parts.push(plural(summary.block_types, 'block type', 'block types'));
  if (summary.media) parts.push(plural(summary.media, 'media file', 'media files'));
  return parts.join(' · ');
}

/** Said wherever an entry is inserted: its styles are created, never mapped. */
export const STYLES_NOTE = 'Inserting creates the styles this entry uses on the site, so it looks the way it was saved. They are never mapped to the site’s nearest styles. A style whose id the site already uses for something different is created under a new id, listed after inserting.';

/** "hero-title → hero-title-2" for each renamed style in an insert report. */
export function renamedStyles(report: CollectionInsertResult['report'] | null | undefined): Array<{ from: string; to: string }> {
  const renamed = report?.renamed;
  if (Array.isArray(renamed)) return renamed.filter(item => item.section === 'styles').map(({ from, to }) => ({ from, to }));
  const styles = renamed && typeof renamed === 'object' ? (renamed as Record<string, unknown>).styles : undefined;
  if (Array.isArray(styles)) return styles.flatMap(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).to === 'string'
    ? [{ from: String((item as Record<string, unknown>).from ?? ''), to: String((item as Record<string, unknown>).to) }] : []);
  if (styles && typeof styles === 'object') return Object.entries(styles).map(([from, to]) => ({ from, to: String(to) }));
  return [];
}

// ── Editing an entry ──────────────────────────────────────────────────────

export interface EntryFields { name: string; description: string; category: string }

export function entryFieldProblems(fields: EntryFields): Partial<Record<keyof EntryFields, string>> {
  const problems: Partial<Record<keyof EntryFields, string>> = {};
  if (!fields.name.trim()) problems.name = 'Give it a name.';
  else if (fields.name.trim().length > 120) problems.name = 'The name can be at most 120 characters.';
  if (fields.description.trim().length > 500) problems.description = 'The description can be at most 500 characters.';
  if (fields.category.trim().length > 60) problems.category = 'The category can be at most 60 characters.';
  return problems;
}

/** The PATCH body: only fields that changed; an emptied description or category is sent as "". */
export function entryPatch(entry: Pick<CollectionEntryView, 'name' | 'description' | 'category'>, fields: EntryFields): Partial<EntryFields> {
  const patch: Partial<EntryFields> = {};
  if (fields.name.trim() !== entry.name) patch.name = fields.name.trim();
  if (fields.description.trim() !== (entry.description ?? '')) patch.description = fields.description.trim();
  if (fields.category.trim() !== (entry.category ?? '')) patch.category = fields.category.trim();
  return patch;
}

// ── Saving from a site ────────────────────────────────────────────────────

export type SaveKind = Exclude<CollectionEntryKind, 'package'>;
export interface SaveChoice { key: string; kind: SaveKind; id: string; label: string; group: string; category?: string }

/** The collection kind of a site block template: a section, or a block template. */
export const templateSaveKind = (template: { kind?: 'block' | 'section' }): SaveKind => template.kind === 'section' ? 'section' : 'block_template';

/** What a site can save to the collection, from GET /packages/exportable. */
export function saveChoices(exportable: Exportable | null): SaveChoice[] {
  if (!exportable) return [];
  const choice = (kind: SaveKind, id: string, label: string, group: string, category?: string): SaveChoice => ({ key: `${kind}:${id}`, kind, id, label, group, ...(category ? { category } : {}) });
  return [
    ...(exportable.block_templates ?? []).map(t => choice(templateSaveKind(t), t.id, t.name, 'Block templates and sections', t.category)),
    ...(exportable.page_templates ?? []).map(t => choice('page_template', t.id, t.name, 'Page templates')),
    ...(exportable.global_blocks ?? []).map(g => choice('global_block', g.id, g.name, 'Global blocks')),
    ...(exportable.block_types ?? []).map(b => choice('block_type', b.id, b.label, 'Block types')),
  ];
}

export function saveBody(choice: Pick<SaveChoice, 'kind' | 'id'>, fields: Partial<EntryFields> = {}): Record<string, string> {
  const body: Record<string, string> = { kind: choice.kind, id: choice.id };
  if (fields.name?.trim()) body.name = fields.name.trim();
  if (fields.description?.trim()) body.description = fields.description.trim();
  if (fields.category?.trim()) body.category = fields.category.trim();
  return body;
}

// ── Inserting ─────────────────────────────────────────────────────────────

export type InsertTarget = { target: 'library' } | { target: 'page'; page_id: string; after_block_id?: string; position?: number };

export function insertBody(target: InsertTarget): InsertTarget {
  if (target.target === 'library') return { target: 'library' };
  return {
    target: 'page', page_id: target.page_id,
    ...(target.after_block_id ? { after_block_id: target.after_block_id } : {}),
    ...(!target.after_block_id && typeof target.position === 'number' ? { position: target.position } : {}),
  };
}

/** A short line for the editor after an insert: "Inserted Pricing. Created 2 styles; renamed hero → hero-2." */
export function insertedLine(name: string, report: CollectionInsertResult['report'] | null | undefined): string {
  const created = report?.created && typeof report.created === 'object' ? (report.created as Record<string, unknown>).styles : undefined;
  const count = Array.isArray(created) ? created.length : typeof created === 'number' ? created : 0;
  const renamed = renamedStyles(report);
  const moved = new Set(renamed.map(item => item.to));
  const fresh = Array.isArray(created) ? created.filter(item => !(typeof item === 'string' && moved.has(item))).length : count;
  const parts: string[] = [];
  if (fresh) parts.push(`created ${plural(fresh, 'style', 'styles')}`);
  if (renamed.length) parts.push(`renamed ${renamed.map(item => `${item.from} → ${item.to}`).join(', ')}`);
  return `Inserted ${name}.${parts.length ? ` Styles: ${parts.join('; ')}.` : ''}`;
}

/** The 404 the collection API gives a person who may not use it. */
export const COLLECTION_UNAVAILABLE = 'The collection is for the organization’s owners, administrators and builders. A site shared with you from another organization does not show that organization’s collection. Ask an owner or administrator if you need the Builder role.';
