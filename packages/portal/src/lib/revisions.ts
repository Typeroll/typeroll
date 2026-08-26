/**
 * Auto-snapshot helper. Every meaningful save (page / partial / collection
 * item PUT) calls snapshot() with the *pre-edit* doc; we write that snapshot
 * to the active version's revisions subcollection and trim the history so
 * each doc keeps at most CAP entries.
 *
 * Revisions are version-local — they don't fall back through the chain. A
 * fresh branch has zero revisions until you edit something on it. Switch to
 * main to see main's history.
 */

import { paths } from '@typeroll/shared';
import type { Page, Partial as PartialDoc, CollectionItem, Revision, RevisionKind } from '@typeroll/shared';
import { getStore } from './datastore';

/** How many revisions to keep per doc per branch. Oldest get pruned. */
const CAP = 100;

interface SnapshotArgs {
  orgId: string;
  siteId: string;
  versionId: string;
  kind: RevisionKind;
  /** Page id, partial id, or for collection-item: "{name}/{itemId}". */
  resourceIds: string[];
  doc: Record<string, unknown>;
  createdBy: string;
  note?: string;
}

function collectionPath(args: { orgId: string; siteId: string; versionId: string; kind: RevisionKind; resourceIds: string[] }): string {
  const { orgId, siteId, versionId, kind, resourceIds } = args;
  if (kind === 'page') return paths.revisions(orgId, siteId, resourceIds[0], versionId);
  if (kind === 'partial') return paths.partialRevisions(orgId, siteId, resourceIds[0], versionId);
  return paths.itemRevisions(orgId, siteId, resourceIds[0], resourceIds[1], versionId);
}

export async function snapshotRevision(args: SnapshotArgs): Promise<string> {
  const store = getStore();
  const collPath = collectionPath(args);
  // Drop the id off the snapshotted doc so restoring doesn't try to re-inject
  // it as a real field — id is encoded by the doc's path on disk/Firestore.
  const { id: _id, ...body } = args.doc;
  const revId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rev: Omit<Revision, 'id'> = {
    kind: args.kind,
    created_at: new Date().toISOString(),
    created_by: args.createdBy,
    note: args.note,
    doc: body as Record<string, unknown>,
  };
  await store.setDoc(`${collPath}/${revId}`, rev as unknown as Record<string, unknown>);

  // Prune anything beyond CAP. List, sort by created_at desc, delete the tail.
  const all = await store.listDocs<Revision>(collPath);
  if (all.length > CAP) {
    all.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    const toDelete = all.slice(CAP);
    for (const r of toDelete) {
      await store.deleteDoc(`${collPath}/${r.id}`).catch(() => {});
    }
  }
  return revId;
}

export async function listRevisions(args: {
  orgId: string; siteId: string; versionId: string; kind: RevisionKind; resourceIds: string[];
}): Promise<Revision[]> {
  const list = await getStore().listDocs<Revision>(collectionPath(args));
  list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return list;
}

export async function getRevision(args: {
  orgId: string; siteId: string; versionId: string; kind: RevisionKind; resourceIds: string[]; revId: string;
}): Promise<Revision | null> {
  const doc = await getStore().getDoc<Revision>(`${collectionPath(args)}/${args.revId}`);
  return doc;
}

/** Type aliases for the common cases — keep call sites tight. */
export type PageRevision = Revision<Partial<Page>>;
export type PartialRevision = Revision<Partial<PartialDoc>>;
export type ItemRevision = Revision<Partial<CollectionItem>>;
