// The organization collection: entries stored once for an organization and
// inserted into any of its sites (shared collections.ts has the model).
//
// An entry holds a single-entry `.typeroll` package (site-package.ts): its
// blocks with the styles, block types, global blocks and media they need.
// Its files are kept in the organization's private storage by sha256
// (collection-files.ts), so the entry document holds only the manifest.
//
//   - Saving from a site exports the chosen block template, page template,
//     free global block or block type as such a package (package-export.ts).
//   - Adding a `.typeroll` file splits a collection package into one entry
//     per template, global block and block type, each with what it depends
//     on; a whole site package is kept as one entry of kind `package`.
//   - Inserting is a package import (package-import.ts) with only that entry:
//     styles are created on the site, never mapped to "nearest" ones, and
//     differing ones get new ids. Into a page, the blocks are imported the way
//     copied blocks are pasted and placed in the page's draft.
//
// Who may use it is decided by the routes (lib/access → requireCollectionAccess,
// lib/api-auth → requireApiCollection). This module enforces what an app may
// change: only the entries it added itself.

import { randomBytes } from 'node:crypto';
import {
  COLLECTION_ENTRY_ID, MAX_COLLECTION_ENTRIES, blockStyleRefs, blockTypeRefs, builtinCollectionEntries,
  collectionEntryBlocks, collectionEntryFieldErrors, collectionEntryTarget, globalBlockRefs,
  packageMediaRefs, paths, sitePackageErrors, verifySitePackage,
  type Block, type BlockType, type CollectionEntry, type CollectionEntryKind, type CollectionEntrySource,
  type PackageBlockType, type PackageGlobalBlock, type SitePackage, type SharePermission,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { vstore } from '../version-store';
import { listBlockTemplates } from '../block-templates-store';
import { blockTemplateDesignFindings, type TemplateDesignFinding } from '../design-token-audit';
import { exportSitePackage } from '../packages/package-export';
import { importSitePackageIntoVersion, localizePackage, preparePackageImport, trustedPackageKeys, type PackageImportReport, type PreparedImport, type TemplateLanguage } from '../packages/package-import';
import { placePackageBlocks } from '../packages/package-place';
import { packageIntegrity, readSitePackageZip, type PackageFiles } from '../packages/package-zip';
import type { PackageMediaIO } from '../packages/package-media';
import { packageFailureBody } from '../packages/package-requests';
import { CollectionFileError, collectGarbage, defaultCollectionFileIO, type CollectionFileIO } from './collection-files';

export class CollectionError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: Record<string, unknown>) { super(message); }
}

export interface CollectionDeps {
  files?: CollectionFileIO;
  /** Site media (reading on save, storing on insert). */
  media?: PackageMediaIO;
  now?: () => Date;
}

/** Who acts on the collection. An app (`extensionId`) adds entries and changes only its own. */
export interface CollectionActor {
  /** An email address or `api-key:<prefix>`, recorded as created_by. */
  label: string;
  extensionId?: string;
}

/** Entries above this size are refused: the manifest is one datastore document. */
export const MAX_COLLECTION_ENTRY_MANIFEST_BYTES = 1_500_000;
const SAVE_KINDS = ['section', 'block_template', 'page_template', 'global_block', 'block_type'] as const;
type SaveKind = typeof SAVE_KINDS[number];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nowOf = (deps: CollectionDeps) => (deps.now ? deps.now() : new Date());
const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'entry';
const newEntryId = (name: string) => `${slug(name)}-${randomBytes(4).toString('hex')}`;
const fileIO = (deps: CollectionDeps) => deps.files ?? defaultCollectionFileIO;

// ── Reading ───────────────────────────────────────────────────────────────

async function storedEntries(orgId: string): Promise<CollectionEntry[]> {
  return getStore().listDocs<CollectionEntry>(paths.collection(orgId));
}

/** An entry of the organization or a built-in; null when there is none. */
export async function readCollectionEntry(orgId: string, entryId: string, options: { renderVersion?: number } = {}): Promise<CollectionEntry | null> {
  if (typeof entryId !== 'string' || !COLLECTION_ENTRY_ID.test(entryId)) return null;
  const builtin = builtinCollectionEntries(options).find(entry => entry.id === entryId);
  if (builtin) return builtin;
  const stored = await getStore().getDoc<CollectionEntry>(paths.collectionEntry(orgId, entryId));
  return stored ? { ...stored, id: entryId } : null;
}

function countBlocks(blocks: readonly Block[] | undefined, depth = 0): number {
  if (!Array.isArray(blocks) || depth > 64) return 0;
  return blocks.reduce((sum: number, block: Block) => sum + 1 + countBlocks(block.children, depth + 1) + (block.slots ?? []).reduce((n: number, slot: Block[]) => n + countBlocks(slot, depth + 1), 0), 0);
}

function entryBlocksForSummary(entry: CollectionEntry): Block[] | null {
  const c = entry.package.contents;
  if (entry.kind === 'page_template') return c.page_templates?.[0]?.blocks ?? null;
  if (entry.kind === 'global_block') return c.global_blocks?.[0]?.blocks ?? null;
  if (entry.kind === 'block_type' || entry.kind === 'package') return null;
  return collectionEntryBlocks(entry);
}

/** An entry for listing: without its package, with counts and a preview address. */
export function collectionEntrySummary(entry: CollectionEntry, previewBase: string) {
  const blocks = entryBlocksForSummary(entry);
  const c = entry.package.contents;
  return {
    id: entry.id, kind: entry.kind, name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.preview && entry.package.media.some(media => media.id === entry.preview) ? { preview_url: `${previewBase}/${encodeURIComponent(entry.id)}/media/${encodeURIComponent(entry.preview)}` } : {}),
    ...(entry.languages?.length ? { languages: entry.languages } : {}),
    source: entry.source,
    ...(entry.read_only ? { read_only: true } : {}),
    created_at: entry.created_at, updated_at: entry.updated_at,
    summary: {
      ...(blocks ? { block_count: countBlocks(blocks), top_level_types: [...new Set(blocks.map(block => block.type))] } : {}),
      styles: c.styles?.length ?? 0,
      block_types: c.block_types?.length ?? 0,
      media: entry.package.media.length,
      ...(entry.kind === 'package' ? { pages: c.pages?.length ?? 0, block_templates: c.block_templates?.length ?? 0 } : {}),
    },
  };
}
export type CollectionEntrySummary = ReturnType<typeof collectionEntrySummary>;

/** The organization's entries, newest first, then Typeroll's built-ins for the site's render version. */
export async function listCollection(orgId: string, options: { renderVersion?: number; previewBase: string }): Promise<CollectionEntrySummary[]> {
  const own = (await storedEntries(orgId)).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  return [...own, ...builtinCollectionEntries({ renderVersion: options.renderVersion })].map(entry => collectionEntrySummary(entry, options.previewBase));
}

/** An entry with its package, as the read routes answer it. */
export function collectionEntryDetail(entry: CollectionEntry, previewBase: string) {
  return { ...collectionEntrySummary(entry, previewBase), package: entry.package };
}

// ── Writing ───────────────────────────────────────────────────────────────

function checkFields(input: { name?: unknown; description?: unknown; category?: unknown }): void {
  const errors = collectionEntryFieldErrors(input);
  if (errors.length) throw new CollectionError(errors.join('; '), 400, 'collection_entry_invalid');
}

async function assertRoom(orgId: string, adding: number): Promise<void> {
  const count = (await storedEntries(orgId)).length;
  if (count + adding > MAX_COLLECTION_ENTRIES) {
    throw new CollectionError(`The collection holds at most ${MAX_COLLECTION_ENTRIES} entries; it has ${count}. Delete some first.`, 409, 'collection_full');
  }
}

/** Store an entry's files and the entry document. */
async function storeEntry(orgId: string, entry: CollectionEntry, files: ReadonlyMap<string, Uint8Array>, deps: CollectionDeps): Promise<CollectionEntry> {
  const size = Buffer.byteLength(JSON.stringify(entry.package));
  if (size > MAX_COLLECTION_ENTRY_MANIFEST_BYTES) {
    throw new CollectionError(`The entry "${entry.name}" is too large for the collection (${Math.round(size / 1024)} KB of content; at most ${MAX_COLLECTION_ENTRY_MANIFEST_BYTES / 1000} KB)`, 413, 'collection_entry_too_large');
  }
  const contentTypes = new Map<string, string>([
    ...entry.package.media.map(media => [media.path, media.content_type] as const),
    ...(entry.package.fonts ?? []).map(font => [font.path, 'font/woff2'] as const),
  ]);
  for (const [path, sha] of Object.entries(entry.package.integrity.files)) {
    const bytes = files.get(path);
    if (!bytes) throw new CollectionError(`The entry's file ${path} is missing`, 422, 'collection_entry_invalid');
    const stored = await fileIO(deps).put(orgId, bytes, contentTypes.get(path) ?? 'application/octet-stream');
    if (stored !== sha) throw new CollectionError(`The entry's file ${path} does not match its sha256`, 422, 'collection_entry_invalid');
  }
  const { id, ...doc } = entry;
  if (!await getStore().createDocIfMissing(paths.collectionEntry(orgId, id), doc as unknown as Record<string, unknown>)) {
    throw new CollectionError('An entry with this id exists; try again', 409, 'collection_conflict');
  }
  return entry;
}

export interface SaveFromSiteInput { kind: unknown; id: unknown; name?: unknown; description?: unknown; category?: unknown }

/**
 * Save one of a site's block templates, page templates, free global blocks or
 * block types to its organization's collection. A block template becomes a
 * `section` or a `block_template` entry by the template's own kind.
 */
export async function saveToCollection(ctx: { orgId: string; siteId: string; versionId: string }, input: SaveFromSiteInput, actor: CollectionActor, deps: CollectionDeps = {}): Promise<{ entry: CollectionEntry; warnings: string[]; design_findings?: TemplateDesignFinding[] }> {
  if (typeof input.kind !== 'string' || !(SAVE_KINDS as readonly string[]).includes(input.kind)) {
    throw new CollectionError(`kind must be one of ${SAVE_KINDS.join(', ')}`, 400, 'collection_entry_invalid');
  }
  if (typeof input.id !== 'string' || !input.id || input.id.length > 100) throw new CollectionError('id must be the id of the site\'s template, global block or block type', 400, 'collection_entry_invalid');
  checkFields(input);
  const id = input.id;
  const kind = input.kind as SaveKind;
  const { orgId, siteId, versionId } = ctx;
  let entryKind: CollectionEntryKind = kind;
  let defaults: { name: string; description?: string; category?: string; preview?: boolean };
  let selection: Parameters<typeof exportSitePackage>[1];
  const missing = () => new CollectionError(`The site has no ${kind.replace(/_/g, ' ')} "${id}"`, 404, 'collection_source_not_found');
  if (kind === 'section' || kind === 'block_template') {
    const template = (await listBlockTemplates({ orgId, siteId })).find(candidate => candidate.id === id);
    if (!template) throw missing();
    entryKind = template.kind === 'section' ? 'section' : 'block_template';
    defaults = { name: template.name, description: template.description, category: template.category, preview: !!template.preview };
    selection = { kind: 'collection', block_templates: [id] };
  } else if (kind === 'page_template') {
    const template = (await vstore.pageTemplates(orgId, siteId, versionId)).find(candidate => candidate.id === id);
    if (!template) throw missing();
    defaults = { name: template.label ?? template.name ?? id };
    selection = { kind: 'collection', page_templates: [id] };
  } else if (kind === 'global_block') {
    const partial = (await vstore.partials(orgId, siteId, versionId)).find(candidate => candidate.id === id);
    if (!partial) throw missing();
    if (partial.kind !== 'free' || partial.content_mode !== 'blocks') throw new CollectionError('Only free global blocks made of blocks are saved to the collection; the header and footer belong to their site', 400, 'collection_entry_invalid');
    defaults = { name: partial.name ?? id };
    selection = { kind: 'collection', global_blocks: [id] };
  } else {
    const type = (await vstore.blockTypes(orgId, siteId, versionId)).find(candidate => candidate.id === id);
    if (!type || type.extension) throw missing();
    defaults = { name: type.label ?? id, description: typeof type.description === 'string' ? type.description : undefined };
    selection = { kind: 'collection', block_types: [id] };
  }
  await assertRoom(orgId, 1);
  const name = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : defaults.name).slice(0, 120);
  const entryId = newEntryId(name);
  const exported = await exportSitePackage(ctx, selection, { id: entryId.slice(0, 64), name, version: '1' }, { media: deps.media });
  const pkg = exported.manifest;
  const description = typeof input.description === 'string' ? input.description : defaults.description?.slice(0, 500);
  const category = typeof input.category === 'string' ? input.category : defaults.category?.slice(0, 60);
  const preview = defaults.preview ? pkg.contents.block_templates?.[0]?.preview : undefined;
  const stamp = nowOf(deps).toISOString();
  const entry: CollectionEntry = {
    id: entryId, kind: entryKind, name,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(preview ? { preview } : {}),
    ...(pkg.languages?.length ? { languages: pkg.languages } : {}),
    package: pkg,
    source: { type: 'site', site_id: siteId },
    created_by: actor.label, created_at: stamp, updated_at: stamp,
  };
  await storeEntry(orgId, entry, exported.files, deps);
  // A saved block template: its hard-coded colours and fonts, with the token or role to use (non-blocking).
  const template = kind === 'section' || kind === 'block_template' ? (await listBlockTemplates({ orgId, siteId })).find(candidate => candidate.id === id) : undefined;
  return { entry, warnings: exported.warnings, ...(template ? { design_findings: await blockTemplateDesignFindings(ctx, template) } : {}) };
}

// ── Adding a package ──────────────────────────────────────────────────────

function typeDependencies(type: PackageBlockType): string[] {
  const out = new Set<string>(blockTypeRefs((type as unknown as BlockType).composition ?? []));
  const expand = (type as unknown as BlockType).expand_to;
  if (expand?.target) out.add(expand.target);
  const item = (expand?.defaults as Record<string, unknown> | undefined)?.item_block;
  if (typeof item === 'string') out.add(item);
  return [...out];
}

/** A single-entry package: the chosen content and what it depends on, with only its files. */
function singleEntryPackage(pkg: SitePackage, files: ReadonlyMap<string, Uint8Array>, pick: Partial<SitePackage['contents']>, name: string): { pkg: SitePackage; files: Map<string, Uint8Array> } {
  const c = pkg.contents;
  const globals = new Map((c.global_blocks ?? []).map(global => [global.id, global]));
  const chosenGlobals = new Map<string, PackageGlobalBlock>((pick.global_blocks ?? []).map(global => [global.id, global]));
  const trees = () => [
    ...(pick.block_templates ?? []).map(t => t.blocks), ...(pick.page_templates ?? []).map(t => t.blocks ?? []),
    ...(pick.blocks ? [pick.blocks] : []), ...[...chosenGlobals.values()].map(g => g.blocks),
  ];
  // Global blocks the content places, and the global blocks those place.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of trees().flatMap(tree => globalBlockRefs(tree))) {
      const global = globals.get(id);
      if (global && !chosenGlobals.has(id)) { chosenGlobals.set(id, global); changed = true; }
    }
  }
  const types = new Map((c.block_types ?? []).map(type => [type.id, type]));
  const wantedTypes = new Set<string>([...(pick.block_types ?? []).map(type => type.id), ...trees().flatMap(tree => blockTypeRefs(tree)).filter(id => types.has(id))]);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...wantedTypes]) for (const dependency of typeDependencies(types.get(id)!)) {
      if (types.has(dependency) && !wantedTypes.has(dependency)) { wantedTypes.add(dependency); changed = true; }
    }
  }
  const blockTypes = [...wantedTypes].sort().map(id => types.get(id)!);
  const usedStyles = new Set([...trees(), ...blockTypes.map(type => (type as unknown as BlockType).composition ?? [])].flatMap(tree => blockStyleRefs(tree)));
  const styles = (c.styles ?? []).filter(style => usedStyles.has(style.id));
  const contents: SitePackage['contents'] = {
    ...(pick.block_templates?.length ? { block_templates: pick.block_templates } : {}),
    ...(pick.page_templates?.length ? { page_templates: pick.page_templates } : {}),
    ...(pick.blocks ? { blocks: pick.blocks } : {}),
    ...(chosenGlobals.size ? { global_blocks: [...chosenGlobals.values()] } : {}),
    ...(blockTypes.length ? { block_types: blockTypes } : {}),
    ...(styles.length ? { styles } : {}),
  };
  const usedMedia = new Set([...packageMediaRefs(contents), ...(pick.block_templates ?? []).flatMap(t => t.preview ? [t.preview] : [])]);
  const media = pkg.media.filter(entry => usedMedia.has(entry.id));
  const entryFiles = new Map(media.flatMap(entry => files.has(entry.path) ? [[entry.path, files.get(entry.path)!] as const] : []));
  const { signature: _signature, fonts: _fonts, ...rest } = pkg;
  void _signature; void _fonts;
  return {
    pkg: { ...rest, kind: 'collection', name, contents: clone(contents), media, integrity: packageIntegrity(entryFiles) },
    files: entryFiles,
  };
}

interface SplitEntry { kind: CollectionEntryKind; name: string; description?: string; category?: string; preview?: string; pkg: SitePackage; files: Map<string, Uint8Array> }

/** One entry per template, free global block and block type of a collection package; a site package stays whole. */
export function splitPackage(pkg: SitePackage, files: ReadonlyMap<string, Uint8Array>): { entries: SplitEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  if (pkg.kind === 'site') {
    const kept = new Map(Object.keys(pkg.integrity.files).flatMap(path => files.has(path) ? [[path, files.get(path)!] as const] : []));
    return { entries: [{ kind: 'package', name: pkg.name.slice(0, 120), ...(pkg.description ? { description: pkg.description.slice(0, 500) } : {}), category: 'Sites', pkg, files: kept }], warnings };
  }
  const c = pkg.contents;
  const entries: SplitEntry[] = [];
  const add = (kind: CollectionEntryKind, item: { name: string; description?: string; category?: string; preview?: string }, pick: Partial<SitePackage['contents']>) => {
    const split = singleEntryPackage(pkg, files, pick, item.name.slice(0, 120));
    entries.push({ kind, name: item.name.slice(0, 120), ...(item.description ? { description: item.description.slice(0, 500) } : {}), ...(item.category ? { category: item.category.slice(0, 60) } : {}), ...(item.preview ? { preview: item.preview } : {}), ...split });
  };
  if (pkg.kind === 'clipboard') {
    if (c.blocks?.length) add('block_template', { name: pkg.name }, { block_templates: [{ id: slug(pkg.id || pkg.name), name: pkg.name.slice(0, 120), kind: 'block', blocks: c.blocks }] });
    return { entries, warnings };
  }
  for (const template of c.block_templates ?? []) add(template.kind === 'section' ? 'section' : 'block_template', template, { block_templates: [template] });
  for (const template of c.page_templates ?? []) add('page_template', { name: template.label || template.name || template.id }, { page_templates: [template] });
  for (const global of c.global_blocks ?? []) if (global.kind === 'free') add('global_block', { name: global.name }, { global_blocks: [global] });
  for (const type of c.block_types ?? []) add('block_type', { name: typeof type.label === 'string' && type.label ? type.label : type.id, description: typeof type.description === 'string' ? type.description : undefined }, { block_types: [type] });
  const left = [c.menus?.length ? 'menus' : '', c.design ? 'the design' : '', c.site_fields?.length ? 'settings pages' : '', pkg.fonts?.length ? 'font files' : ''].filter(Boolean);
  if (left.length) warnings.push(`The package's ${left.join(', ')} are not collection entries and are left out; import the package into a site to use them.`);
  if (!entries.length) throw new CollectionError('The package holds no templates, global blocks or block types to add to the collection', 422, 'collection_package_empty');
  return { entries, warnings };
}

/**
 * Add a `.typeroll` file to the organization's collection. A collection
 * package becomes one entry per template, free global block and block type;
 * a site package is kept whole as one entry of kind `package`.
 */
export async function addPackageToCollection(orgId: string, bytes: Uint8Array, actor: CollectionActor, deps: CollectionDeps & { trusted?: Parameters<typeof verifySitePackage>[1] } = {}): Promise<{ entries: CollectionEntry[]; warnings: string[] }> {
  const read: PackageFiles = await readSitePackageZip(bytes);
  const pkg = read.manifest;
  const signature = await verifySitePackage(pkg, deps.trusted ?? trustedPackageKeys());
  const warnings: string[] = [];
  if (signature.status === 'invalid') warnings.push('The package signature does not match its contents: it was changed after it was signed.');
  else if (signature.status === 'unknown_key') warnings.push(`The package is signed with a key this portal does not know (${pkg.signature?.key_id}); its publisher is not verified.`);
  const split = splitPackage(pkg, read.files);
  warnings.push(...split.warnings);
  await assertRoom(orgId, split.entries.length);
  const stamp = nowOf(deps).toISOString();
  const source: CollectionEntrySource = {
    type: actor.extensionId ? 'app' : 'package',
    package_id: pkg.id, package_name: pkg.name, version: pkg.version,
    ...(signature.status === 'verified' && signature.publisher ? { publisher: signature.publisher } : pkg.author?.name ? { publisher: pkg.author.name } : {}),
    verified: signature.status === 'verified',
    ...(actor.extensionId ? { extension_id: actor.extensionId } : {}),
  };
  const entries: CollectionEntry[] = [];
  for (const item of split.entries) {
    const errors = sitePackageErrors(item.pkg);
    if (errors.length) throw new CollectionError(`The entry "${item.name}" cannot be stored: ${errors[0]}`, 422, 'collection_entry_invalid', { errors: errors.slice(0, 20) });
    const entry: CollectionEntry = {
      id: newEntryId(item.name), kind: item.kind, name: item.name || pkg.name,
      ...(item.description ? { description: item.description } : {}),
      ...(item.category ? { category: item.category } : {}),
      ...(item.preview ? { preview: item.preview } : {}),
      ...(pkg.languages?.length ? { languages: pkg.languages } : {}),
      package: item.pkg, source, created_by: actor.label, created_at: stamp, updated_at: stamp,
    };
    entries.push(await storeEntry(orgId, entry, item.files, deps));
  }
  return { entries, warnings };
}

// ── Changing and removing ─────────────────────────────────────────────────

async function writableEntry(orgId: string, entryId: string, actor: CollectionActor): Promise<CollectionEntry> {
  const entry = await readCollectionEntry(orgId, entryId);
  if (!entry) throw new CollectionError('Collection entry not found', 404, 'collection_entry_not_found');
  if (entry.read_only || entry.source.type === 'builtin') throw new CollectionError('Typeroll\'s built-in entries cannot be changed or removed', 403, 'collection_entry_read_only');
  if (actor.extensionId && entry.source.extension_id !== actor.extensionId) throw new CollectionError('An app changes only the collection entries it added', 403, 'collection_entry_not_owned');
  return entry;
}

/** Change an entry's name, description or category. An empty description or category removes it. */
export async function updateCollectionEntry(orgId: string, entryId: string, patch: Record<string, unknown>, actor: CollectionActor, deps: CollectionDeps = {}): Promise<CollectionEntry> {
  const unknown = Object.keys(patch).filter(key => !['name', 'description', 'category'].includes(key));
  if (unknown.length) throw new CollectionError(`Unknown fields: ${unknown.join(', ')}. Accepted: name, description, category`, 400, 'collection_entry_invalid');
  checkFields(patch);
  const entry = await writableEntry(orgId, entryId, actor);
  const next: CollectionEntry = { ...entry, updated_at: nowOf(deps).toISOString() };
  if (typeof patch.name === 'string') next.name = patch.name.trim();
  for (const key of ['description', 'category'] as const) {
    if (typeof patch[key] !== 'string') continue;
    const value = (patch[key] as string).trim();
    if (value) next[key] = value; else delete next[key];
  }
  const { id: _id, ...doc } = next;
  void _id;
  const current = await getStore().getDoc<CollectionEntry>(paths.collectionEntry(orgId, entryId));
  if (!current || !await getStore().compareAndReplaceDoc(paths.collectionEntry(orgId, entryId), current as unknown as Record<string, unknown>, doc as unknown as Record<string, unknown>)) {
    throw new CollectionError('The entry changed while saving; try again', 409, 'collection_conflict');
  }
  return next;
}

/** Remove an entry, and the files no other entry uses. */
export async function deleteCollectionEntry(orgId: string, entryId: string, actor: CollectionActor, deps: CollectionDeps = {}): Promise<{ deleted: true; id: string; files_removed: number }> {
  await writableEntry(orgId, entryId, actor);
  await getStore().deleteDoc(paths.collectionEntry(orgId, entryId));
  const referenced = new Set((await storedEntries(orgId)).flatMap(entry => Object.values(entry.package?.integrity?.files ?? {})));
  const removed = await collectGarbage(orgId, referenced, fileIO(deps), nowOf(deps).getTime());
  return { deleted: true, id: entryId, files_removed: removed.length };
}

/** One file of an entry's package (a preview image), by package media id. */
export async function collectionEntryMedia(orgId: string, entry: CollectionEntry, mediaId: string, deps: CollectionDeps = {}): Promise<{ bytes: Uint8Array; contentType: string; filename: string } | null> {
  const media = entry.package.media.find(candidate => candidate.id === mediaId);
  const sha = media ? entry.package.integrity.files[media.path] : undefined;
  if (!media || !sha) return null;
  return { bytes: await fileIO(deps).get(orgId, sha), contentType: media.content_type, filename: media.filename };
}

// ── Inserting ─────────────────────────────────────────────────────────────

export interface InsertCtx {
  orgId: string; siteId: string; versionId: string;
  permission: SharePermission;
  design?: boolean;
  actor: string;
}

export type InsertTarget =
  | { target: 'library' }
  | { target: 'page'; page_id: string; after_block_id?: string; position?: number; parent_id?: string | null; slot_index?: number };

/** Check an insert request body. */
export function parseInsertTarget(body: unknown): InsertTarget {
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const target = input.target ?? 'library';
  if (target === 'library') {
    const unknown = Object.keys(input).filter(key => key !== 'target');
    if (unknown.length) throw new CollectionError(`Unknown fields for target "library": ${unknown.join(', ')}`, 400, 'collection_insert_invalid');
    return { target: 'library' };
  }
  if (target !== 'page') throw new CollectionError('target must be "library" or "page"', 400, 'collection_insert_invalid');
  const unknown = Object.keys(input).filter(key => !['target', 'page_id', 'after_block_id', 'position', 'parent_id', 'slot_index'].includes(key));
  if (unknown.length) throw new CollectionError(`Unknown fields: ${unknown.join(', ')}. Accepted: target, page_id, after_block_id, position, parent_id, slot_index`, 400, 'collection_insert_invalid');
  if (typeof input.page_id !== 'string' || !input.page_id) throw new CollectionError('page_id is required for target "page"', 400, 'collection_insert_invalid');
  if (input.after_block_id !== undefined && (typeof input.after_block_id !== 'string' || !input.after_block_id)) throw new CollectionError('after_block_id must be a block id', 400, 'collection_insert_invalid');
  if (input.after_block_id !== undefined && (input.position !== undefined || input.parent_id !== undefined || input.slot_index !== undefined)) throw new CollectionError('Send after_block_id or a position, not both', 400, 'collection_insert_invalid');
  for (const key of ['position', 'slot_index'] as const) if (input[key] !== undefined && (!Number.isInteger(input[key]) || (input[key] as number) < 0)) throw new CollectionError(`${key} must be a non-negative integer`, 400, 'collection_insert_invalid');
  if (input.parent_id !== undefined && input.parent_id !== null && typeof input.parent_id !== 'string') throw new CollectionError('parent_id must be a block id or null', 400, 'collection_insert_invalid');
  return {
    target: 'page', page_id: input.page_id,
    ...(typeof input.after_block_id === 'string' ? { after_block_id: input.after_block_id } : {}),
    ...(input.position !== undefined ? { position: input.position as number } : {}),
    ...(input.parent_id !== undefined ? { parent_id: input.parent_id as string | null } : {}),
    ...(input.slot_index !== undefined ? { slot_index: input.slot_index as number } : {}),
  };
}

async function entryFiles(orgId: string, entry: CollectionEntry, deps: CollectionDeps): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const [path, sha] of Object.entries(entry.package.integrity.files)) files.set(path, await fileIO(deps).get(orgId, sha));
  return files;
}

/** An entry's package and its files, as an import reads them (a new site starts from a `package` entry). */
export async function collectionEntryPackage(orgId: string, entry: CollectionEntry, deps: CollectionDeps = {}): Promise<PackageFiles> {
  return { manifest: clone(entry.package), files: await entryFiles(orgId, entry, deps) };
}

/** The package an insert imports: the entry's, adjusted for where it goes. */
function insertPackage(entry: CollectionEntry, target: InsertTarget): { pkg: SitePackage; only?: string[]; place?: Block[] } {
  const pkg = clone(entry.package);
  const global = entry.kind === 'global_block' ? pkg.contents.global_blocks?.[0] : undefined;
  if (global && global.kind !== 'free') {
    if (target.target === 'page') throw new CollectionError('A header or footer is not placed on a page; insert it into the site, where it replaces the site\'s own', 400, 'collection_entry_not_insertable');
    // A site has one header and one footer: importing one as a site package replaces the site's.
    return { pkg: { ...pkg, kind: 'site', contents: { global_blocks: pkg.contents.global_blocks, styles: pkg.contents.styles, block_types: pkg.contents.block_types } } };
  }
  if (target.target === 'library') {
    const only = collectionEntryTarget(entry);
    return { pkg, ...(only ? { only: [only] } : {}) };
  }
  const blocks = collectionEntryBlocks(entry);
  if (!blocks) throw new CollectionError(`A ${entry.kind.replace(/_/g, ' ')} is not placed on a page; insert it into the site's library`, 400, 'collection_entry_not_insertable');
  // Into a page the blocks come the way copied blocks are pasted: the
  // styles, block types, global blocks and media they use are added to the
  // site, and no block template is.
  const { block_templates: _templates, ...rest } = pkg.contents;
  void _templates;
  return { pkg: { ...pkg, kind: 'clipboard', contents: { ...rest, blocks: clone(blocks) } }, place: blocks };
}

export interface InsertResult {
  report: PackageImportReport;
  page?: { id: string; added_ids: string[]; blocks: Block[] };
}

/**
 * Insert an entry into a site: into its library (block template, page
 * template, global block or block type), or its blocks into a page's draft.
 */
export async function insertFromCollection(ctx: InsertCtx, entry: CollectionEntry, target: InsertTarget, deps: CollectionDeps = {}): Promise<InsertResult> {
  if (ctx.permission === 'read') throw new CollectionError('Inserting needs write permission on the site', 403, 'collection_permission');
  const site = { orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId };
  // Sample text in the site's language, or the page's when it has one; the
  // library import picks the site's language itself (package-import.ts).
  let templateLanguages: TemplateLanguage[] = [];
  if (target.target === 'page') {
    const [page, settings] = await Promise.all([vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, target.page_id), vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)]);
    const localized = localizePackage(entry.package, page?.language || settings?.language);
    entry = { ...entry, package: localized.pkg };
    templateLanguages = localized.languages;
  }
  const { pkg, only, place } = insertPackage(entry, target);
  // The entry was checked when it was stored; its own signature (a whole package) is reported in the warnings.
  const dropUnsigned = (prepared: PreparedImport) => { prepared.warnings = prepared.warnings.filter(warning => !warning.startsWith('The package is not signed')); };
  if (target.target === 'page' && place) {
    // The blocks come the way copied blocks are pasted (package-place.ts);
    // the page and position are checked before anything is written.
    const files = await entryFiles(ctx.orgId, entry, deps);
    return placePackageBlocks(ctx, { manifest: pkg, files }, place, target, { code: 'collection_insert_invalid', media: deps.media, prepare: (prepared) => { dropUnsigned(prepared); if (templateLanguages.length) prepared.templateLanguages = templateLanguages; } });
  }
  const files = await entryFiles(ctx.orgId, entry, deps);
  const prepared = await preparePackageImport(site, { manifest: pkg, files }, { design: 'content', ...(only ? { only } : {}) });
  dropUnsigned(prepared);
  const report = await importSitePackageIntoVersion({ ...site, permission: ctx.permission, design: ctx.design, actor: ctx.actor }, prepared, { media: deps.media });
  return { report };
}

// ── Errors ────────────────────────────────────────────────────────────────

/** A refused collection request as `{ status, body: { error, code, details? } }`, or null for an unexpected error. */
export function collectionFailureBody(error: unknown): { status: number; body: { error: string; code: string; details?: Record<string, unknown> } } | null {
  if (error instanceof CollectionError) return { status: error.status, body: { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) } };
  if (error instanceof CollectionFileError) return { status: error.status, body: { error: error.message, code: error.status === 404 ? 'not_found' : 'collection_file_unavailable' } };
  const refused = packageFailureBody(error);
  return refused ? { status: refused.status, body: { ...refused.body, code: refused.body.code ?? 'collection_storage_unavailable' } } : null;
}
