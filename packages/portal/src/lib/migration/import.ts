// Idempotent import of export records into the sharded store.
//
// Records are written below the store API, straight to each object's engine:
// one read and one revision-guarded commit per object and batch, so a full
// import fits the maintenance window, and nothing is re-derived. The export
// already holds the `scheduled_work` index as Firestore had it; it is copied to
// the global object like any other root collection, and no work is delivered
// while importing.
//
// Per document: absent → created; equal → unchanged; different → a conflict
// that is reported and left alone, unless `force` replaces it. A site
// document's organization copy (which lets an organization list its sites)
// always mirrors the site object's final value.

import type { ShardedStore } from '../store/sharded-store';
import { ownerPath, shardFor } from '../store/sharded-store';
import type { StoreTransport } from '../store/sql-store';
import type { Precondition, StoredDoc, Write } from '../store/sql-engine';
import { canonicalJson, parseRecordLine } from './format';
import { transformRecord } from './transform';

/** The store, and the transports it was built on (the same resolver). */
export interface MigrationTarget {
  store: ShardedStore;
  transport(shard: string): StoreTransport;
}

export interface ImportOptions { force?: boolean; dryRun?: boolean; maxDocumentBytes?: number }

export interface ImportReport {
  records: number;
  created: number;
  unchanged: number;
  overwritten: number;
  /** Existing documents that differ from the record and were left alone. */
  conflicts: Array<{ line: number; path: string }>;
  dropped: Record<string, number>;
  /** Kept in their stored (compressed) encoding because they exceed the row limit. */
  compressed: string[];
  /** Documents with an `id` field that differs from their id; the SQL store cannot keep it. */
  idMismatches: string[];
  orgCopies: { created: number; unchanged: number; updated: number };
  errors: Array<{ line: number; path?: string; error: string }>;
}

export const emptyImportReport = (): ImportReport => ({
  records: 0, created: 0, unchanged: 0, overwritten: 0, conflicts: [], dropped: {}, compressed: [], idMismatches: [],
  orgCopies: { created: 0, unchanged: 0, updated: 0 }, errors: [],
});

export const importFailed = (report: ImportReport) => report.conflicts.length > 0 || report.errors.length > 0;

const isSiteDoc = (path: string) => /^organizations\/[^/]+\/sites\/[^/]+$/.test(path);
const COMMIT_BYTES = 4_000_000, COMMIT_DOCS = 200, ATTEMPTS = 5, UNASSIGNED = '';

/** Object name for a path; for a site without an ownership row, null unless `create`. */
export async function resolveShard(target: MigrationTarget, path: string, create: boolean): Promise<string | null> {
  const shard = shardFor(path);
  if (shard.kind === 'global') return 'global';
  if (shard.kind === 'org') return `org:${shard.org}`;
  if (create) return `site:${await target.store.siteUid(shard.org, shard.site)}`;
  const owner = await target.transport('global').get(ownerPath(shard.org, shard.site));
  return owner ? `site:${owner.data.uid}` : null;
}

/** Create the ownership row, and so the object, of every exported site before any document. */
export async function ensureSiteOwners(target: MigrationTarget, sites: string[], dryRun = false): Promise<number> {
  let created = 0;
  for (const pair of sites) {
    const [org, site] = pair.split('/') as [string, string];
    if (await target.transport('global').get(ownerPath(org, site))) continue;
    created++;
    if (!dryRun) await target.store.siteUid(org, site);
  }
  return created;
}

type Decision = 'created' | 'unchanged' | 'overwritten' | 'conflict';

/** Write documents into one object; returns each path's decision. Retries the batch if a document changed meanwhile. */
async function writeObject(transport: StoreTransport | null, docs: Array<{ path: string; data: Record<string, any> }>, opts: { force: boolean; dryRun: boolean }): Promise<Map<string, Decision>> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const current: Array<StoredDoc | null> = transport ? await transport.getMany(docs.map(doc => doc.path)) : docs.map(() => null);
    const decisions = new Map<string, Decision>(), writes: Write[] = [], preconditions: Precondition[] = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!, before = current[i] ?? null;
      let decision: Decision;
      if (!before) decision = 'created';
      else if (canonicalJson(before.data) === canonicalJson(doc.data)) decision = 'unchanged';
      else decision = opts.force ? 'overwritten' : 'conflict';
      decisions.set(doc.path, decision);
      if (decision === 'created' || decision === 'overwritten') {
        writes.push({ path: doc.path, op: 'set', data: doc.data });
        preconditions.push({ path: doc.path, revision: before?.revision ?? null });
      }
    }
    if (!writes.length || opts.dryRun || !transport) return decisions;
    if ((await transport.commit(preconditions, writes)).ok) return decisions;
  }
  throw new Error(`Documents kept changing during the import: ${docs[0]?.path}`);
}

function batches<T extends { data: Record<string, any> }>(items: T[]): T[][] {
  const result: T[][] = [];
  let current: T[] = [], bytes = 0;
  for (const item of items) {
    const size = JSON.stringify(item.data).length;
    if (current.length && (current.length >= COMMIT_DOCS || bytes + size > COMMIT_BYTES)) { result.push(current); current = []; bytes = 0; }
    current.push(item); bytes += size;
  }
  if (current.length) result.push(current);
  return result;
}

/** Import numbered export lines (a chunk of the file) into the target, adding to `report`. */
export async function importLines(target: MigrationTarget, lines: Array<{ line: number; text: string }>, opts: ImportOptions, report: ImportReport): Promise<void> {
  const force = opts.force === true, dryRun = opts.dryRun === true;
  const byShard = new Map<string, Array<{ line: number; path: string; data: Record<string, any> }>>();
  for (const { line, text } of lines) {
    const parsed = parseRecordLine(text);
    if ('error' in parsed) { report.errors.push({ line, error: parsed.error }); continue; }
    report.records++;
    const result = transformRecord(parsed.record, { maxDocumentBytes: opts.maxDocumentBytes });
    if (result.kind === 'drop') { report.dropped[result.reason] = (report.dropped[result.reason] ?? 0) + 1; continue; }
    if (result.kind === 'error') { report.errors.push({ line, path: result.path, error: result.error }); continue; }
    if (result.compressed) report.compressed.push(result.path);
    if (result.idMismatch) report.idMismatches.push(result.path);
    // In a dry run a new site has no object yet; its documents would all be created.
    const shard = await resolveShard(target, result.path, !dryRun) ?? UNASSIGNED;
    let group = byShard.get(shard);
    if (!group) byShard.set(shard, group = []);
    group.push({ line, path: result.path, data: result.data });
  }

  const siteDocs: Array<{ path: string; data: Record<string, any> | null }> = [];
  for (const [shard, docs] of byShard) {
    const transport = shard === UNASSIGNED ? null : target.transport(shard);
    for (const batch of batches(docs)) {
      const decisions = await writeObject(transport, batch, { force, dryRun });
      for (const doc of batch) {
        const decision = decisions.get(doc.path)!;
        if (decision === 'conflict') report.conflicts.push({ line: doc.line, path: doc.path });
        else report[decision]++;
        if (isSiteDoc(doc.path)) siteDocs.push({ path: doc.path, data: decision === 'conflict' ? null : doc.data });
      }
    }
  }

  // Organization copies mirror the site object's value (also after a conflict left it alone).
  for (const doc of siteDocs) {
    const shard = await resolveShard(target, doc.path, false);
    const data = doc.data ?? (shard ? (await target.transport(shard).get(doc.path))?.data ?? null : null);
    if (!data) continue;
    const org = `org:${(shardFor(doc.path) as { org: string }).org}`;
    const decision = (await writeObject(dryRun ? null : target.transport(org), [{ path: doc.path, data }], { force: true, dryRun })).get(doc.path)!;
    report.orgCopies[decision === 'overwritten' ? 'updated' : decision === 'created' ? 'created' : 'unchanged']++;
  }
}

/** Re-apply any outbox entries left in the objects of the exported organizations and sites. */
export async function drainOutboxes(target: MigrationTarget, manifest: { organizations: string[]; sites: string[] }): Promise<number> {
  const shards = ['global', ...manifest.organizations.map(org => `org:${org}`)];
  for (const pair of manifest.sites) {
    const [org, site] = pair.split('/') as [string, string];
    const owner = await target.transport('global').get(ownerPath(org, site));
    if (owner) shards.push(`site:${owner.data.uid}`);
  }
  let drained = 0;
  for (const shard of shards) drained += await target.store.drainOutbox(shard);
  return drained;
}
