/**
 * Promote / reset / diff operations between a branch and its base version.
 *
 * These work on *literal* storage (paths.X with the branch id) — not through
 * the COW chain. We need to know exactly which docs the branch has overridden
 * or tombstoned to classify the changes and to apply or roll them back.
 */

import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type {
  CollectionDef,
  CollectionItem,
  Page,
  Partial as PartialDoc,
  Redirect,
  RevisionKind,
  SiteSettings,
} from '@typeroll/shared';
import { getStore } from './datastore';
import { snapshotRevision } from './revisions';

export type ChangeSet = { added: string[]; modified: string[]; deleted: string[] };

export interface VersionDiff {
  pages: ChangeSet;
  partials: ChangeSet;
  redirects: ChangeSet;
  collections: ChangeSet;
  /** Per-collection changes for items. Empty record means no item changes. */
  collectionItems: Record<string, ChangeSet>;
  settings: 'unchanged' | 'modified';
  /** Total number of changed entities across the diff. */
  totalChanges: number;
}

// Kind goes in the collection name so doc paths have an even number of
// segments — Firestore requirement. See version-store.ts for the canonical
// helpers; this file duplicates them locally to avoid a circular import.
function tombstoneCollectionPath(orgId: string, siteId: string, versionId: string, kind: string): string {
  return `organizations/${orgId}/sites/${siteId}/versions/${versionId}/_tombstones_${kind}`;
}
function tombstonePath(orgId: string, siteId: string, versionId: string, kind: string, id: string): string {
  return `${tombstoneCollectionPath(orgId, siteId, versionId, kind)}/${id}`;
}

/** Compare a set of branch ids to a set of base ids, classifying each branch id. */
function classify(branchIds: Set<string>, baseIds: Set<string>, branchTombstones: Set<string>): ChangeSet {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const id of branchIds) {
    if (baseIds.has(id)) modified.push(id);
    else added.push(id);
  }
  for (const id of branchTombstones) {
    if (baseIds.has(id)) deleted.push(id);
    // A tombstone for an id that base doesn't have is spurious; skip it.
  }
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

async function listIds(path: string): Promise<Set<string>> {
  const docs = await getStore().listDocs<{ id?: string }>(path);
  const out = new Set<string>();
  for (const d of docs) if (d.id) out.add(d.id);
  return out;
}

export async function diffVersion(
  orgId: string,
  siteId: string,
  branchId: string,
  baseId: string = MAIN_VERSION_ID,
): Promise<VersionDiff> {
  // Pages
  const branchPages = await listIds(paths.pages(orgId, siteId, branchId));
  const basePages = await listIds(paths.pages(orgId, siteId, baseId));
  const branchPageTombs = await listIds(tombstoneCollectionPath(orgId, siteId, branchId, 'pages'));
  const pages = classify(branchPages, basePages, branchPageTombs);

  // Partials
  const branchPartials = await listIds(paths.partials(orgId, siteId, branchId));
  const basePartials = await listIds(paths.partials(orgId, siteId, baseId));
  const branchPartialTombs = await listIds(tombstoneCollectionPath(orgId, siteId, branchId, 'partials'));
  const partials = classify(branchPartials, basePartials, branchPartialTombs);

  // Redirects
  const branchRedirects = await listIds(paths.redirects(orgId, siteId, branchId));
  const baseRedirects = await listIds(paths.redirects(orgId, siteId, baseId));
  const branchRedirectTombs = await listIds(tombstoneCollectionPath(orgId, siteId, branchId, 'redirects'));
  const redirects = classify(branchRedirects, baseRedirects, branchRedirectTombs);

  // Collections (defs) + per-collection items
  const branchColls = await listIds(paths.collections(orgId, siteId, branchId));
  const baseColls = await listIds(paths.collections(orgId, siteId, baseId));
  const branchCollTombs = await listIds(tombstoneCollectionPath(orgId, siteId, branchId, 'collections'));
  const collections = classify(branchColls, baseColls, branchCollTombs);

  // Items for every collection that exists on either side. We need to also
  // catch items added on collections that existed before the branch.
  const allCollIds = new Set<string>([...branchColls, ...baseColls]);
  const collectionItems: Record<string, ChangeSet> = {};
  for (const name of allCollIds) {
    const branchItems = await listIds(paths.collectionItems(orgId, siteId, name, branchId));
    const baseItems = await listIds(paths.collectionItems(orgId, siteId, name, baseId));
    const branchItemTombs = await listIds(tombstoneCollectionPath(orgId, siteId, branchId, `collection-items:${name}`));
    const cs = classify(branchItems, baseItems, branchItemTombs);
    if (cs.added.length || cs.modified.length || cs.deleted.length) {
      collectionItems[name] = cs;
    }
  }

  // Settings (singleton)
  const branchSettings = await getStore().getDoc<SiteSettings>(paths.settings(orgId, siteId, branchId));
  const settings: 'unchanged' | 'modified' = branchSettings ? 'modified' : 'unchanged';

  const totalChanges =
    pages.added.length + pages.modified.length + pages.deleted.length +
    partials.added.length + partials.modified.length + partials.deleted.length +
    redirects.added.length + redirects.modified.length + redirects.deleted.length +
    collections.added.length + collections.modified.length + collections.deleted.length +
    Object.values(collectionItems).reduce(
      (n, c) => n + c.added.length + c.modified.length + c.deleted.length,
      0,
    ) +
    (settings === 'modified' ? 1 : 0);

  return { pages, partials, redirects, collections, collectionItems, settings, totalChanges };
}

/**
 * Apply a branch's overrides and tombstones to its base version. The branch
 * itself is left as-is (still has its overrides), which means switching back
 * to the branch will render identical to base immediately after promote.
 * Users can then delete the branch when they're done.
 */
export async function promoteBranch(
  orgId: string,
  siteId: string,
  branchId: string,
  baseId: string = MAIN_VERSION_ID,
  promotedBy: string = 'promote',
): Promise<VersionDiff> {
  const store = getStore();
  const diff = await diffVersion(orgId, siteId, branchId, baseId);

  // Snapshot main's current doc (if any) so the promote itself is undoable
  // from main's history — same posture as any normal edit.
  async function snapshotBase(kind: RevisionKind, resourceIds: string[], basePath: string): Promise<void> {
    const current = await store.getDoc<Record<string, unknown>>(basePath);
    if (!current) return;
    await snapshotRevision({
      orgId, siteId, versionId: baseId,
      kind, resourceIds,
      doc: current,
      createdBy: promotedBy,
      note: `Promoted from branch "${branchId}"`,
    });
  }

  // Helper: copy a doc from one path to another, stripping the id field.
  async function copy<T extends { id?: string }>(fromPath: string, toPath: string): Promise<void> {
    const doc = await store.getDoc<T>(fromPath);
    if (!doc) return;
    const { id: _id, ...rest } = doc;
    await store.setDoc(toPath, rest as unknown as Record<string, unknown>);
  }

  // Pages
  for (const id of [...diff.pages.added, ...diff.pages.modified, ...diff.pages.deleted]) {
    await snapshotBase('page', [id], paths.page(orgId, siteId, id, baseId));
  }
  for (const id of [...diff.pages.added, ...diff.pages.modified]) {
    await copy(paths.page(orgId, siteId, id, branchId), paths.page(orgId, siteId, id, baseId));
  }
  for (const id of diff.pages.deleted) {
    await store.deleteDoc(paths.page(orgId, siteId, id, baseId)).catch(() => {});
  }

  // Partials
  for (const id of [...diff.partials.added, ...diff.partials.modified, ...diff.partials.deleted]) {
    await snapshotBase('partial', [id], paths.partial(orgId, siteId, id, baseId));
  }
  for (const id of [...diff.partials.added, ...diff.partials.modified]) {
    await copy(paths.partial(orgId, siteId, id, branchId), paths.partial(orgId, siteId, id, baseId));
  }
  for (const id of diff.partials.deleted) {
    await store.deleteDoc(paths.partial(orgId, siteId, id, baseId)).catch(() => {});
  }

  // Redirects
  for (const id of [...diff.redirects.added, ...diff.redirects.modified]) {
    await copy(
      `${paths.redirects(orgId, siteId, branchId)}/${id}`,
      `${paths.redirects(orgId, siteId, baseId)}/${id}`,
    );
  }
  for (const id of diff.redirects.deleted) {
    await store.deleteDoc(`${paths.redirects(orgId, siteId, baseId)}/${id}`).catch(() => {});
  }

  // Collections (defs)
  for (const name of [...diff.collections.added, ...diff.collections.modified]) {
    await copy(paths.collection(orgId, siteId, name, branchId), paths.collection(orgId, siteId, name, baseId));
  }
  for (const name of diff.collections.deleted) {
    await store.deleteDoc(paths.collection(orgId, siteId, name, baseId)).catch(() => {});
  }

  // Collection items per-collection
  for (const [name, cs] of Object.entries(diff.collectionItems)) {
    for (const id of [...cs.added, ...cs.modified, ...cs.deleted]) {
      await snapshotBase('collection-item', [name, id], paths.collectionItem(orgId, siteId, name, id, baseId));
    }
    for (const id of [...cs.added, ...cs.modified]) {
      await copy(
        paths.collectionItem(orgId, siteId, name, id, branchId),
        paths.collectionItem(orgId, siteId, name, id, baseId),
      );
    }
    for (const id of cs.deleted) {
      await store.deleteDoc(paths.collectionItem(orgId, siteId, name, id, baseId)).catch(() => {});
    }
  }

  // Settings
  if (diff.settings === 'modified') {
    await copy(paths.settings(orgId, siteId, branchId), paths.settings(orgId, siteId, baseId));
  }

  return diff;
}

/**
 * Discard every override and tombstone on a branch. Reads through the branch
 * will then resolve straight to base. The branch's revision history is
 * preserved — only the override files are removed.
 */
export async function resetBranch(
  orgId: string,
  siteId: string,
  branchId: string,
): Promise<VersionDiff> {
  const store = getStore();
  const diff = await diffVersion(orgId, siteId, branchId);

  async function deleteAll(ids: string[], toPath: (id: string) => string): Promise<void> {
    for (const id of ids) await store.deleteDoc(toPath(id)).catch(() => {});
  }

  // Override files
  await deleteAll(
    [...diff.pages.added, ...diff.pages.modified],
    (id) => paths.page(orgId, siteId, id, branchId),
  );
  await deleteAll(
    [...diff.partials.added, ...diff.partials.modified],
    (id) => paths.partial(orgId, siteId, id, branchId),
  );
  await deleteAll(
    [...diff.redirects.added, ...diff.redirects.modified],
    (id) => `${paths.redirects(orgId, siteId, branchId)}/${id}`,
  );
  await deleteAll(
    [...diff.collections.added, ...diff.collections.modified],
    (name) => paths.collection(orgId, siteId, name, branchId),
  );
  for (const [name, cs] of Object.entries(diff.collectionItems)) {
    await deleteAll(
      [...cs.added, ...cs.modified],
      (id) => paths.collectionItem(orgId, siteId, name, id, branchId),
    );
  }
  if (diff.settings === 'modified') {
    await store.deleteDoc(paths.settings(orgId, siteId, branchId)).catch(() => {});
  }

  // Tombstones
  for (const id of diff.pages.deleted) {
    await store.deleteDoc(tombstonePath(orgId, siteId, branchId, 'pages', id)).catch(() => {});
  }
  for (const id of diff.partials.deleted) {
    await store.deleteDoc(tombstonePath(orgId, siteId, branchId, 'partials', id)).catch(() => {});
  }
  for (const id of diff.redirects.deleted) {
    await store.deleteDoc(tombstonePath(orgId, siteId, branchId, 'redirects', id)).catch(() => {});
  }
  for (const name of diff.collections.deleted) {
    await store.deleteDoc(tombstonePath(orgId, siteId, branchId, 'collections', name)).catch(() => {});
  }
  for (const [name, cs] of Object.entries(diff.collectionItems)) {
    for (const id of cs.deleted) {
      await store
        .deleteDoc(tombstonePath(orgId, siteId, branchId, `collection-items:${name}`, id))
        .catch(() => {});
    }
  }

  return diff;
}
