/**
 * Copy-on-write read/list/delete helpers for per-version content.
 *
 * Branches are stored as deltas: a SiteVersion doc with a base_version_id
 * pointer, plus only the docs the user has actually changed on that branch.
 * Reads walk the chain (branch → base → ... → main); writes go straight to
 * the active branch's path so the override lives at that version only.
 *
 * Tombstones model deletions on a branch. They sit at:
 *   organizations/{org}/sites/{site}/versions/{ver}/_tombstones_{kind}/{id}
 * A read that hits a tombstone before finding an override returns null; the
 * list helpers skip tombstoned ids when merging chain results.
 *
 * Path helpers (paths.X) still return the *literal* path for one version.
 * vstore composes those with the chain — callers that want COW behaviour
 * use vstore.X(...) instead of store.getDoc(paths.X(...)).
 */

import { pageAuthorityFields, pageContentValues, PAGE_BUILTIN_FIELDS, contentPagePath, DEFAULT_CONTENT_TYPE, paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type {
  BlockType,
  ContentType,
  Page,
  PageTemplate,
  Partial as PartialDoc,
  Redirect,
  SiteSettings,
  SiteVersion,
} from '@typeroll/shared';
import { getStore } from './datastore';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyFieldAuthority, conflictResponse, readProvenance, type WriteActor } from './field-authority';

export class PageWriteConflict extends Error { readonly status = 409; }
export interface PageWriteContext {
  actor: WriteActor; actorId: string; expected?: Page;
  overrideReason?: string; sourceUrl?: string; importRunId?: string;
  contentType?: ContentType;
  sources?: Record<string, { source_url?: string; import_run_id?: string }>;
  /** Server-only branch promotion. Read and guard the source instead of trusting
   * caller-supplied provenance, including a provenance map on `update`. */
  promotedFrom?: string;
}


/** Snapshot both the effective document and every mutable copy-on-write dependency. */
async function guardedResource<T>(orgId: string, siteId: string, versionId: string, kind: string, id: string, pathFor: (version: string) => string) {
  const store = getStore();
  const guards: import('./datastore').ConditionalEffect[] = [];
  const chain = await versionChain(orgId, siteId, versionId, guards);
  let value: T | null = null, physical: T | null = null;
  for (const version of chain) {
    const path = pathFor(version), doc = await store.getDoc<T>(path);
    if (version === versionId) physical = doc;
    guards.push({ path, data: {}, expected: doc as Record<string, unknown> | null, guardOnly: true });
    const tombstone = tombstonePath(orgId, siteId, version, kind, id);
    const removed = await store.getDoc(tombstone);
    guards.push({ path: tombstone, data: {}, expected: removed, guardOnly: true });
    if (removed) break;
    if (doc) { value = doc; break; }
  }
  return { value, physical, destination: pathFor(versionId), guards };
}
export async function pageWriteSnapshot(orgId: string, siteId: string, versionId: string, pageId: string) {
  const { value, ...snapshot } = await guardedResource<Page>(orgId, siteId, versionId, 'pages', pageId, version => paths.page(orgId, siteId, pageId, version));
  return { ...snapshot, page: value };
}
export async function contentTypeWriteSnapshot(orgId: string, siteId: string, versionId: string, name: string) {
  const { value, ...snapshot } = await guardedResource<ContentType>(orgId, siteId, versionId, 'content_types', name, version => paths.contentType(orgId, siteId, name, version));
  return { ...snapshot, type: value };
}

type WithMaybeId = { id?: string };

/** Main can be virtual or contain only publication metadata on legacy sites. */
export async function listSiteVersions(orgId: string, siteId: string, createdAt?: string): Promise<SiteVersion[]> {
  const versions = await getStore().listDocs<SiteVersion>(paths.versions(orgId, siteId));
  const storedMain = versions.find(version => version.id === MAIN_VERSION_ID);
  const main: SiteVersion = { ...storedMain, id: MAIN_VERSION_ID, name: 'Main', kind: 'main',
    created_at: storedMain?.created_at ?? createdAt ?? new Date().toISOString(), robots_blocked: storedMain?.robots_blocked ?? false };
  const branches = versions.filter(version => version.id !== MAIN_VERSION_ID);
  branches.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  return [main, ...branches];
}


/** Resolved version chain, branch first → main last. Memoised per request. */
async function versionChain(orgId: string, siteId: string, versionId: string, guards?: import('./datastore').ConditionalEffect[]): Promise<string[]> {
  const chain: string[] = [];
  let cur = versionId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    if (cur === MAIN_VERSION_ID) break;
    const versionPath = paths.version(orgId, siteId, cur);
    const v = await getStore().getDoc<SiteVersion>(versionPath);
    if (guards) guards.push({ path: versionPath, expected: v as unknown as Record<string, unknown> | null, data: {}, guardOnly: true });
    cur = v?.base_version_id ?? MAIN_VERSION_ID;
  }
  // Make sure main is always at the bottom of the chain, even if we walked
  // off a dangling pointer.
  if (chain[chain.length - 1] !== MAIN_VERSION_ID) chain.push(MAIN_VERSION_ID);
  return chain;
}

// Tombstones live in one subcollection per kind under the version, e.g.
//   organizations/{org}/sites/{site}/versions/{ver}/_tombstones_pages/{id}
//
// The kind is appended to the collection name (not a separate path segment)
// so the doc path has an even number of segments — Firestore requires
// alternating collection/doc and rejects odd-length paths.
function tombstonePath(orgId: string, siteId: string, versionId: string, kind: string, id: string): string {
  return `organizations/${orgId}/sites/${siteId}/versions/${versionId}/_tombstones_${kind}/${id}`;
}
function tombstoneCollectionPath(orgId: string, siteId: string, versionId: string, kind: string): string {
  return `organizations/${orgId}/sites/${siteId}/versions/${versionId}/_tombstones_${kind}`;
}

/**
 * Single-doc read with chain fallback. `kind` names the resource for tombstone
 * lookup; `pathFor(v)` returns the literal path for that doc on a given
 * version.
 */
async function readChain<T>(
  orgId: string,
  siteId: string,
  versionId: string,
  kind: string,
  id: string,
  pathFor: (v: string) => string,
): Promise<T | null> {
  const store = getStore();
  const chain = await versionChain(orgId, siteId, versionId);
  for (const v of chain) {
    // A tombstone on this version means the doc has been deleted *here*; any
    // existence further down the chain is shadowed.
    if (await store.getDoc<{ deleted: true }>(tombstonePath(orgId, siteId, v, kind, id))) {
      return null;
    }
    const doc = await store.getDoc<T>(pathFor(v));
    if (doc) return doc;
  }
  return null;
}

/**
 * Collection list with chain fallback. Branch entries win over base entries
 * with the same id; tombstones (anywhere in the chain) hide that id from the
 * result.
 */
async function listChain<T extends WithMaybeId>(
  orgId: string,
  siteId: string,
  versionId: string,
  kind: string,
  pathFor: (v: string) => string,
): Promise<T[]> {
  const store = getStore();
  const chain = await versionChain(orgId, siteId, versionId);
  const out = new Map<string, T>();
  const hidden = new Set<string>();
  for (const v of chain) {
    const tombstones = await store.listDocs<{ id: string }>(
      tombstoneCollectionPath(orgId, siteId, v, kind),
    );
    for (const t of tombstones) if (t.id) hidden.add(t.id);
    const docs = await store.listDocs<T>(pathFor(v));
    for (const doc of docs) {
      const id = doc.id;
      if (!id) continue;
      if (hidden.has(id)) continue;
      if (out.has(id)) continue; // first hit (further-toward-branch) wins
      out.set(id, doc);
    }
  }
  return Array.from(out.values());
}

/** Write a tombstone marker on the active branch (no-op on main). */
async function writeTombstone(
  orgId: string,
  siteId: string,
  versionId: string,
  kind: string,
  id: string,
): Promise<void> {
  await getStore().setDoc(tombstonePath(orgId, siteId, versionId, kind, id), {
    deleted: true,
    deleted_at: new Date().toISOString(),
  });
}

/**
 * Delete semantics:
 * - On main: literal delete (no one shadows main).
 * - On a branch: write a tombstone if the doc exists anywhere up the chain;
 *   the branch's own override (if any) is also deleted literally so the
 *   storage doesn't carry stale data.
 */
async function deleteChain(
  orgId: string,
  siteId: string,
  versionId: string,
  kind: string,
  id: string,
  literalPath: string,
): Promise<void> {
  const store = getStore();
  if (versionId === MAIN_VERSION_ID) {
    await store.deleteDoc(literalPath);
    return;
  }
  // Drop the local override if any, then tombstone so base remains shadowed.
  await store.deleteDoc(literalPath).catch(() => {});
  await writeTombstone(orgId, siteId, versionId, kind, id);
}

// ─── Per-resource façades ────────────────────────────────────────────────

export const vstore = {
  // Pages
  page: (orgId: string, siteId: string, versionId: string, pageId: string) =>
    readChain<Page>(orgId, siteId, versionId, 'pages', pageId, v => paths.page(orgId, siteId, pageId, v)),
  pages: (orgId: string, siteId: string, versionId: string) =>
    listChain<Page>(orgId, siteId, versionId, 'pages', v => paths.pages(orgId, siteId, v)),
  deletePage: (orgId: string, siteId: string, versionId: string, pageId: string) =>
    deleteChain(orgId, siteId, versionId, 'pages', pageId,
      paths.page(orgId, siteId, pageId, versionId)),

  // Partials (global blocks)
  partial: (orgId: string, siteId: string, versionId: string, partialId: string) =>
    readChain<PartialDoc>(orgId, siteId, versionId, 'partials', partialId,
      (v) => paths.partial(orgId, siteId, partialId, v)),
  partials: (orgId: string, siteId: string, versionId: string) =>
    listChain<PartialDoc>(orgId, siteId, versionId, 'partials',
      (v) => paths.partials(orgId, siteId, v)),
  deletePartial: (orgId: string, siteId: string, versionId: string, partialId: string) =>
    deleteChain(orgId, siteId, versionId, 'partials', partialId,
      paths.partial(orgId, siteId, partialId, versionId)),

  // Settings (singleton)
  settings: (orgId: string, siteId: string, versionId: string) =>
    readChain<SiteSettings>(orgId, siteId, versionId, 'settings', 'default',
      (v) => paths.settings(orgId, siteId, v)),

  // Redirects
  redirect: (orgId: string, siteId: string, versionId: string, redirectId: string) =>
    readChain<Redirect>(orgId, siteId, versionId, 'redirects', redirectId,
      (v) => `${paths.redirects(orgId, siteId, v)}/${redirectId}`),
  redirects: (orgId: string, siteId: string, versionId: string) =>
    listChain<Redirect>(orgId, siteId, versionId, 'redirects',
      (v) => paths.redirects(orgId, siteId, v)),
  deleteRedirect: (orgId: string, siteId: string, versionId: string, redirectId: string) =>
    deleteChain(orgId, siteId, versionId, 'redirects', redirectId,
      `${paths.redirects(orgId, siteId, versionId)}/${redirectId}`),

  contentType: (orgId: string, siteId: string, versionId: string, name: string) =>
    readChain<ContentType>(orgId, siteId, versionId, 'content_types', name,
      v => paths.contentType(orgId, siteId, name, v)),
  contentTypes: (orgId: string, siteId: string, versionId: string) =>
    listChain<ContentType>(orgId, siteId, versionId, 'content_types',
      v => paths.contentTypes(orgId, siteId, v)),
  writeContentType: async (orgId: string, siteId: string, versionId: string, name: string, update: Partial<ContentType>) => {
    const existing = await readChain<ContentType>(orgId, siteId, versionId, 'content_types', name, v => paths.contentType(orgId, siteId, name, v));
    await getStore().setDoc(paths.contentType(orgId, siteId, name, versionId), { ...existing, ...update });
    await getStore().deleteDoc(tombstonePath(orgId, siteId, versionId, 'content_types', name));
  },
  deleteContentType: (orgId: string, siteId: string, versionId: string, name: string) =>
    deleteChain(orgId, siteId, versionId, 'content_types', name, paths.contentType(orgId, siteId, name, versionId)),

  // Block types + page templates. Chain-fallback so a branch build inherits
  // the base library / templates it didn't override (the deploy materializer
  // reads these — without fallback a branch deploy drops every non-overridden
  // block type / template, the same class of bug as missing settings).
  blockTypes: (orgId: string, siteId: string, versionId: string) =>
    listChain<BlockType>(orgId, siteId, versionId, 'block-types',
      (v) => paths.blockTypes(orgId, siteId, v)),
  blockType: (orgId: string, siteId: string, versionId: string, typeId: string) =>
    readChain<BlockType>(orgId, siteId, versionId, 'block-types', typeId,
      (v) => paths.blockType(orgId, siteId, typeId, v)),
  writeBlockType: async (
    orgId: string, siteId: string, versionId: string, typeId: string,
    update: Partial<BlockType>,
  ): Promise<void> => {
    const existing = await readChain<BlockType>(orgId, siteId, versionId, 'block-types', typeId,
      (v) => paths.blockType(orgId, siteId, typeId, v));
    const { id: _id, ...base } = (existing ?? {}) as BlockType;
    await getStore().setDoc(paths.blockType(orgId, siteId, typeId, versionId), { ...base, ...update });
    await getStore().deleteDoc(tombstonePath(orgId, siteId, versionId, 'block-types', typeId));
  },
  deleteBlockType: (orgId: string, siteId: string, versionId: string, typeId: string) =>
    deleteChain(orgId, siteId, versionId, 'block-types', typeId,
      paths.blockType(orgId, siteId, typeId, versionId)),
  pageTemplates: (orgId: string, siteId: string, versionId: string) =>
    listChain<PageTemplate>(orgId, siteId, versionId, 'page-templates',
      (v) => paths.pageTemplates(orgId, siteId, v)),
  pageTemplate: (orgId: string, siteId: string, versionId: string, templateId: string) =>
    readChain<PageTemplate>(orgId, siteId, versionId, 'page-templates', templateId,
      (v) => paths.pageTemplate(orgId, siteId, templateId, v)),
  writePageTemplate: async (orgId: string, siteId: string, versionId: string, templateId: string, update: Partial<PageTemplate>) => {
    const existing = await readChain<PageTemplate>(orgId, siteId, versionId, 'page-templates', templateId,
      v => paths.pageTemplate(orgId, siteId, templateId, v));
    await getStore().setDoc(paths.pageTemplate(orgId, siteId, templateId, versionId), { ...existing, ...update });
    await getStore().deleteDoc(tombstonePath(orgId, siteId, versionId, 'page-templates', templateId));
  },
  deletePageTemplate: (orgId: string, siteId: string, versionId: string, templateId: string) =>
    deleteChain(orgId, siteId, versionId, 'page-templates', templateId, paths.pageTemplate(orgId, siteId, templateId, versionId)),

  // Helpers exposed for advanced callers (deploy materializer, promote op)
  chain: versionChain,

  // ─── Fork-on-write writers ──────────────────────────────────────────
  // Each writeX reads the existing doc through the chain (so a branch sees
  // base content even if it has no local override yet), merges the supplied
  // updates, then setDoc's the full doc at the active version's path. This
  // is the materialise-on-first-write step that makes COW work — without it,
  // a branch's partial override would shadow the base copy and the page
  // would render with missing fields.

  writePage: async (
    orgId: string, siteId: string, versionId: string, pageId: string,
    update: Partial<Page>, context?: PageWriteContext,
  ): Promise<void> => {
    const store = getStore(), destination = paths.page(orgId, siteId, pageId, versionId);
    if (context?.promotedFrom !== undefined && (context.actor !== 'portal' || !context.promotedFrom || context.promotedFrom === versionId))
      throw new PageWriteConflict('Invalid Page promotion context.');
    const promotion = context?.promotedFrom ? await pageWriteSnapshot(orgId, siteId, context.promotedFrom, pageId) : undefined;
    if (promotion && (!promotion.page || !isDeepStrictEqual(promotion.page, update)))
      throw new PageWriteConflict('Source Page changed. Reload before promoting.');
    const snapshot = await pageWriteSnapshot(orgId, siteId, versionId, pageId);
    const { physical, page: existing } = snapshot;
    if (context?.expected && !isDeepStrictEqual(existing, context.expected)) throw new PageWriteConflict('Page changed. Reload before saving.');
    const { id: _id, ...base } = (existing ?? {}) as Page;
    const next = { ...base, ...update };
    // Never accept caller-supplied provenance, including revision restores.
    if (existing?._provenance) next._provenance = existing._provenance;
    else delete next._provenance;
    const typeName = promotion?.page?.content_type ?? existing?.content_type ?? update.content_type ?? 'page';
    const schema = await contentTypeWriteSnapshot(orgId, siteId, versionId, typeName);
    const sourceSchema = context?.promotedFrom ? await contentTypeWriteSnapshot(orgId, siteId, context.promotedFrom, typeName) : undefined;
    const type = sourceSchema ? sourceSchema.type ?? (typeName === 'page' ? DEFAULT_CONTENT_TYPE : null)
      : context?.contentType ?? schema.type ?? (typeName === 'page' ? DEFAULT_CONTENT_TYPE : null);
    if (!type) throw new PageWriteConflict('The Page content type is unavailable. Restore it before saving.');
    const fields = pageAuthorityFields(type);
    const result = applyFieldAuthority({ fields, incoming: { ...update, ...update.fields }, existing: existing ?? undefined,
      actor: context?.actor ?? 'agent', actorId: context?.actorId ?? 'internal',
      overrideReason: context?.overrideReason, sourceUrl: context?.sourceUrl, importRunId: context?.importRunId, sources: context?.sources,
      ...(promotion ? { persistedProvenance: readProvenance(promotion.page ?? undefined) } : {}) });
    if (result.rejected.length) throw new PageWriteConflict(conflictResponse(result.rejected).error);
    if (update.fields) next.fields = { ...existing?.fields, ...Object.fromEntries(Object.entries(result.update).filter(([name]) => !PAGE_BUILTIN_FIELDS.has(name))) };
    for (const [name, value] of Object.entries(result.update)) if (PAGE_BUILTIN_FIELDS.has(name)) (next as Record<string, unknown>)[name] = value;
    next._provenance = result.provenance;
    const changed = !isDeepStrictEqual(existing?._provenance ?? {}, result.provenance);
    const effects: import('./datastore').ConditionalEffect[] = changed ? [{ path: `${destination}/answer_history/${randomUUID()}`, data: {
      actor: context?.actor ?? 'agent', actor_id: context?.actorId ?? 'internal', at: new Date().toISOString(),
      before: existing ? pageContentValues(existing) : {}, after: pageContentValues(next as Page), provenance: result.provenance,
      ...(context?.promotedFrom ? { promoted_from: context.promotedFrom } : {}),
      ...(context?.overrideReason ? { override_reason: context.overrideReason } : {}),
    } }] : [];
    effects.push(...snapshot.guards.filter(guard => guard.path !== destination), ...schema.guards);
    if (promotion) effects.push(...promotion.guards, ...(sourceSchema?.guards ?? []));
    if (!(await store.compareAndReplaceDoc(destination, physical, next, effects))) throw new PageWriteConflict('Page changed. Reload before saving.');
    await store.deleteDoc(tombstonePath(orgId, siteId, versionId, 'pages', pageId));
  },

  writePartial: async (
    orgId: string, siteId: string, versionId: string, partialId: string,
    update: Partial<PartialDoc>,
  ): Promise<void> => {
    const existing = await readChain<PartialDoc>(orgId, siteId, versionId, 'partials', partialId,
      (v) => paths.partial(orgId, siteId, partialId, v));
    const { id: _id, ...base } = (existing ?? {}) as PartialDoc;
    await getStore().setDoc(paths.partial(orgId, siteId, partialId, versionId), { ...base, ...update });
    await getStore().deleteDoc(tombstonePath(orgId, siteId, versionId, 'partials', partialId));
  },

  writeSettings: async (
    orgId: string, siteId: string, versionId: string,
    update: Partial<SiteSettings>,
  ): Promise<void> => {
    const existing = await readChain<SiteSettings>(orgId, siteId, versionId, 'settings', 'default',
      (v) => paths.settings(orgId, siteId, v));
    await getStore().setDoc(paths.settings(orgId, siteId, versionId), { ...(existing ?? {}), ...update });
  },


};
