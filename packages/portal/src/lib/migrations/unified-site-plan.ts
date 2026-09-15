import { createHash } from 'node:crypto';
import type { BlockType, Page, PageTemplate, Partial as PartialDoc, Block } from '@typeroll/shared';
import { migrateContentSnapshot, unifiedPageIds, type LegacyContentSnapshot, type LegacyContentType, type LegacyItem, type UnifiedContentSnapshot } from './unified-pages';

/** An offline, complete site export. Keys are relative to the site document. */
export type SiteDocuments = Record<string, Record<string, unknown>>;
export interface UnifiedSitePlan {
  format: 'typeroll-unified-pages-v1';
  source_hash: string;
  result_hash: string;
  documents: SiteDocuments;
  removed_paths: string[];
  mappings: UnifiedContentSnapshot['mappings'];
  versions: Array<{ id: string; pages: number; content_types: number; templates: number }>;
  warnings: UnifiedContentSnapshot['warnings'];
}
const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
  return value;
}
export function siteDocumentHash(documents: SiteDocuments): string {
  return createHash('sha256').update(JSON.stringify(canonical(documents))).digest('hex');
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const idKey = (type: string, id: string) => JSON.stringify([type, id]);

/**
 * Prepare the entire cutover in memory. The input is never modified. There is
 * no runtime legacy reader: after cutover only native Pages remain. A caller
 * must freeze writes and verify source_hash before replacing storage.
 */
export function planUnifiedSiteMigration(source: SiteDocuments, now: string): UnifiedSitePlan {
  if (source['_migrations/unified-pages']?.format === 'typeroll-unified-pages-v1') throw new Error('Site already uses unified Pages');
  const versions = new Set(['main']);
  for (const path of Object.keys(source)) {
    const match = path.match(/^versions\/([^/]+)/);
    if (match) versions.add(match[1]);
  }
  function chain(version: string): string[] {
    const result: string[] = [];
    let current = version;
    while (current) {
      if (result.includes(current)) throw new Error(`Version inheritance cycle at ${current}`);
      if (!versions.has(current)) throw new Error(`Missing base version ${current}`);
      result.push(current);
      if (current === 'main') break;
      current = String(source[`versions/${current}`]?.base_version_id ?? 'main');
    }
    return result;
  }
  function literal(version: string, namespace: string): Array<Record<string, unknown> & { id: string }> {
    const prefix = `versions/${version}/${namespace}/`;
    return Object.entries(source).flatMap(([path, value]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
      ? [{ ...clone(value), id: path.slice(prefix.length) }] : []);
  }
  function resolved(version: string, namespace: string, tombstone = namespace): Array<Record<string, unknown> & { id: string }> {
    const found = new Map<string, Record<string, unknown> & { id: string }>();
    const hidden = new Set<string>();
    for (const parent of chain(version)) {
      for (const tomb of literal(parent, `_tombstones_${tombstone}`)) hidden.add(tomb.id);
      for (const doc of literal(parent, namespace)) if (!hidden.has(doc.id) && !found.has(doc.id)) found.set(doc.id, doc);
    }
    return [...found.values()];
  }
  const ordered = [...versions].sort((a, b) => chain(a).length - chain(b).length || a.localeCompare(b));
  const snapshots: LegacyContentSnapshot[] = ordered.map(version => ({ version,
    pages: resolved(version, 'pages') as unknown as Page[],
    partials: resolved(version, 'partials') as unknown as PartialDoc[],
    templates: resolved(version, 'page_templates', 'page-templates') as unknown as PageTemplate[],
    blockTypes: resolved(version, 'block_types', 'block-types') as unknown as BlockType[],
    collections: (resolved(version, 'collections') as unknown as LegacyContentType[]).map(definition => ({
      definition, items: resolved(version, `collections/${definition.name}/items`, `collection-items:${definition.name}`) as LegacyItem[],
    })),
  }));
  // Reserve identities from history and deleted records too. A deleted page
  // must never collide with a live page when its revision is restored later.
  const identities: LegacyContentSnapshot = { version: '$identities', pages: [], collections: [], templates: [] };
  const historical = new Map<string, Set<string>>();
  for (const path of Object.keys(source)) {
    const item = path.match(/^versions\/[^/]+\/collections\/([^/]+)\/items\/([^/]+)(?:\/|$)/)
      ?? path.match(/^versions\/[^/]+\/_tombstones_collection-items:([^/]+)\/([^/]+)$/);
    if (item) { const set = historical.get(item[1]) ?? new Set(); set.add(item[2]); historical.set(item[1], set); }
    const page = path.match(/^versions\/[^/]+\/(?:pages|_tombstones_pages)\/([^/]+)(?:\/|$)/);
    if (page) identities.pages.push({ id: page[1] } as Page);
  }
  for (const [name, ids] of historical) identities.collections.push({
    definition: { id: name, name, label_singular: name, label_plural: name, fields: [] },
    items: [...ids].map(id => ({ id })),
  });
  const ids = unifiedPageIds([...snapshots, identities]);
  const results = new Map(snapshots.map(snapshot => [snapshot.version, migrateContentSnapshot(snapshot, ids, now)]));
  const output = clone(source);
  const removed: string[] = [];
  const drop = (path: string) => { if (path in output) { delete output[path]; removed.push(path); } };
  const warnings: UnifiedContentSnapshot['warnings'] = [];
  const mappings = new Map<string, UnifiedContentSnapshot['mappings'][number]>();
  const bySnapshot = new Map(snapshots.map(snapshot => [snapshot.version, snapshot]));

  // Delete the obsolete namespace only in the planned result, including its
  // revisions and tombstones. Revisions are re-keyed below before application.
  for (const path of Object.keys(output)) if (/^versions\/[^/]+\/(?:collections(?:\/|$)|_tombstones_collections\/|_tombstones_collection-items:)/.test(path)) drop(path);

  function writeDelta(version: string, namespace: string, docs: Array<{ id: string }>, baseDocs: Array<{ id: string }>, tombstone = namespace): void {
    const prefix = `versions/${version}/${namespace}/`;
    for (const path of Object.keys(output)) if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) drop(path);
    const base = new Map(baseDocs.map(doc => [doc.id, doc]));
    const current = new Set(docs.map(doc => doc.id));
    for (const doc of docs) {
      // Identical inherited documents stay inherited; branch edits remain deltas.
      if (version !== 'main' && equal(doc, base.get(doc.id))) continue;
      const { id, ...data } = doc;
      output[`${prefix}${id}`] = clone(data);
      drop(`versions/${version}/_tombstones_${tombstone}/${id}`);
    }
    if (version !== 'main') for (const id of base.keys()) if (!current.has(id)) output[`versions/${version}/_tombstones_${tombstone}/${id}`] = { deleted: true, migrated_at: now };
  }
  for (const version of ordered) {
    const result = results.get(version)!;
    const parent = version === 'main' ? undefined : results.get(chain(version)[1]);
    writeDelta(version, 'pages', result.pages, parent?.pages ?? []);
    writeDelta(version, 'partials', result.partials, parent?.partials ?? []);
    writeDelta(version, 'content_types', result.contentTypes, parent?.contentTypes ?? []);
    writeDelta(version, 'page_templates', result.templates, parent?.templates ?? [], 'page-templates');
    writeDelta(version, 'block_types', result.blockTypes, parent?.blockTypes ?? [], 'block-types');
    warnings.push(...result.warnings.map(warning => ({ ...warning, page: `${version}/${warning.page}` })));
    for (const mapping of result.mappings) mappings.set(idKey(mapping.collection, mapping.item), mapping);
  }

  function migrateSingle(version: string, type: string | null, id: string, doc: Record<string, unknown>): Page {
    const snapshot = bySnapshot.get(version)!;
    if (!type) return migrateContentSnapshot({ ...snapshot, pages: [{ ...doc, id } as unknown as Page], collections: [], templates: [] }, ids, now).pages[0];
    const definition = snapshot.collections.find(entry => entry.definition.name === type)?.definition
      ?? snapshots.flatMap(snapshot => snapshot.collections).find(entry => entry.definition.name === type)?.definition;
    if (!definition) throw new Error(`Missing historical schema for ${type}/${id}`);
    return migrateContentSnapshot({ ...snapshot, pages: [], collections: [{ definition, items: [{ ...doc, id }] }], templates: [] }, ids, now).pages[0];
  }
  for (const [path, doc] of Object.entries(source)) {
    const history = path.match(/^versions\/([^/]+)\/(?:collections\/([^/]+)\/items\/([^/]+)|pages\/([^/]+))\/revisions\/([^/]+)$/);
    if (history) {
      const [, version, type, itemId, pageId, revision] = history;
      if (!doc.doc || typeof doc.doc !== 'object') throw new Error(`Invalid revision snapshot at ${path}`);
      const page = migrateSingle(version, type ?? null, itemId ?? pageId, doc.doc as Record<string, unknown>);
      const destination = `versions/${version}/pages/${page.id}/revisions/${revision}`;
      if (destination !== path && destination in output) throw new Error(`Revision collision at ${destination}`);
      const { id: _id, ...body } = page;
      output[destination] = { ...clone(doc), kind: 'page', doc: body };
      if ('resource_id' in doc) output[destination].resource_id = page.id;
      if (destination !== path) drop(path);
    }
    const draft = path.match(/^versions\/([^/]+)\/working_copies\/([^/]+)$/);
    if (draft && ['item', 'page'].includes(String(doc.kind))) {
      const version = draft[1], type = doc.kind === 'item' ? String(doc.collection) : null, originalId = String(doc.target_id);
      const snapshot = bySnapshot.get(version)!;
      const original = type ? snapshot.collections.find(entry => entry.definition.name === type)?.items.find(item => item.id === originalId)
        : snapshot.pages.find(page => page.id === originalId);
      if (!original) throw new Error(`Working copy has no canonical page at ${path}`);
      if (!doc.fields || typeof doc.fields !== 'object' || Array.isArray(doc.fields)) throw new Error(`Invalid working copy at ${path}`);
      const saved = migrateSingle(version, type, originalId, original as unknown as Record<string, unknown>);
      const edited = migrateSingle(version, type, originalId, { ...original, ...doc.fields });
      const fields = Object.fromEntries(Object.entries(edited).filter(([key, value]) => key !== 'id' && !equal(value, (saved as unknown as Record<string, unknown>)[key])));
      const destination = `versions/${version}/working_copies/page--${edited.id}`;
      const { collection: _collection, ...metadata } = doc;
      output[destination] = { ...metadata, kind: 'page', target_id: edited.id, fields };
      if (destination !== path) drop(path);
    }
    if (/^edit_grants\/[^/]+$/.test(path) && typeof doc.collection === 'string') {
      const target = ids.get(idKey(doc.collection, String(doc.item_id)));
      if (!target) throw new Error(`Edit grant refers to unknown page at ${path}`);
      const { collection, item_id: _item, ...metadata } = doc;
      output[path] = { ...metadata, content_type: ids.get(idKey('$type', collection)) ?? collection, page_id: target };
    }
  }
  function migratePartial(version: string, id: string, doc: Record<string, unknown>): PartialDoc {
    const snapshot = bySnapshot.get(version)!;
    return migrateContentSnapshot({ ...snapshot, pages: [], collections: [], templates: [], partials: [{ ...doc, id } as unknown as PartialDoc] }, ids, now).partials[0];
  }
  function migrateEmbeddedBlocks(blocks: unknown): Block[] {
    if (!Array.isArray(blocks)) throw new Error('Invalid embedded block tree');
    return migratePartial('main', 'embedded', { content_mode: 'blocks', blocks }).blocks!;
  }
  const migrateScopes = (value: unknown): unknown => Array.isArray(value)
    ? [...new Set(value.map(scope => typeof scope === 'string' ? scope.replace(/^collections:(read|write)$/, 'content:$1') : scope))] : value;
  for (const [path, doc] of Object.entries(source)) {
    const history = path.match(/^versions\/([^/]+)\/partials\/([^/]+)\/revisions\/[^/]+$/);
    if (history) {
      if (!doc.doc || typeof doc.doc !== 'object') throw new Error(`Invalid partial revision at ${path}`);
      const { id: _id, ...body } = migratePartial(history[1], history[2], doc.doc as Record<string, unknown>);
      output[path] = { ...clone(doc), doc: body };
    }
    const draft = path.match(/^versions\/([^/]+)\/working_copies\/[^/]+$/);
    if (draft && doc.kind === 'partial' && doc.fields && typeof doc.fields === 'object') {
      const original = bySnapshot.get(draft[1])!.partials?.find(partial => partial.id === doc.target_id);
      if (!original) throw new Error(`Partial working copy has no canonical content at ${path}`);
      const saved = migratePartial(draft[1], original.id, original as unknown as Record<string, unknown>);
      const edited = migratePartial(draft[1], original.id, { ...original, ...doc.fields });
      output[path] = { ...clone(doc), fields: Object.fromEntries(Object.entries(edited).filter(([key, value]) => key !== 'id' && !equal(value, (saved as unknown as Record<string, unknown>)[key]))) };
    }
    if (/^apps\/[^/]+$/.test(path)) {
      const apps = clone(doc.apps) as Record<string, { config?: Record<string, unknown> }> | undefined;
      const config = apps?.directory?.config;
      if (config && typeof config.collection === 'string') {
        config.content_type = ids.get(idKey('$type', config.collection)) ?? config.collection;
        delete config.collection;
      }
      if (apps) output[path] = { ...clone(doc), apps };
    }
    if (/^forms\/[^/]+$/.test(path) && Array.isArray(doc.steps)) {
      output[path] = { ...clone(doc), steps: doc.steps.map(step => ({ ...step, ...(step.blocks ? { blocks: migrateEmbeddedBlocks(step.blocks) } : {}) })) };
    }
    // Granted scopes retain their exact operation after namespace consolidation.
    if (/^(?:extension_installations|extensions|api_keys)\/[^/]+$/.test(path)) {
      for (const field of ['scopes', 'granted_scopes']) if (field in doc) output[path][field] = migrateScopes(doc[field]);
    }
    if (/^workflows\/[^/]+$/.test(path) && doc.status && !['completed', 'failed', 'cancelled'].includes(String(doc.status))) {
      throw new Error(`Finish or cancel active workflow before migration: ${path}`);
    }
  }
  // No orphaned documents are discarded silently. Unknown collection history
  // formats need a migration handler before any persistent write can happen.
  for (const path of removed) if (/\/items\/[^/]+\//.test(path) && !/\/revisions\/[^/]+$/.test(path)) throw new Error(`Unsupported item subdocument at ${path}`);
  output['_migrations/unified-pages'] = { format: 'typeroll-unified-pages-v1', migrated_at: now, source_hash: siteDocumentHash(source) };
  return { format: 'typeroll-unified-pages-v1', source_hash: siteDocumentHash(source), result_hash: siteDocumentHash(output), documents: canonical(output) as SiteDocuments,
    removed_paths: [...new Set(removed)].filter(path => !(path in output)).sort(), mappings: [...mappings.values()],
    versions: ordered.map(id => ({ id, pages: results.get(id)!.pages.length, content_types: results.get(id)!.contentTypes.length, templates: results.get(id)!.templates.length })), warnings };
}
