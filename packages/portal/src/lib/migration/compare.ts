// Read-compare: re-read every exported document from the target and compare
// the value a reader sees (transform.ts `logicalValue`) with the record after
// the documented transforms. Site documents are also compared with their
// organization's copy. Differences name the first differing JSON pointer, never
// the values, so a report can be shared without customer data or secrets.

import { fixedObjectName, ownerPath, shardFor, stripMirrorRevision } from '../store/sharded-store';
import { canonicalJson, collectionGroup, isPlainObject, parseRecordLine, type ExportRecord } from './format';
import type { MigrationTarget } from './import';
import { logicalValue, transformRecord } from './transform';
import type { ReadWriteStore } from '../datastore';

export interface CompareReader {
  /** Values as `getDoc` returns them, without `id`; null when absent. */
  getMany(paths: string[]): Promise<Array<Record<string, any> | null>>;
  /** The organization's copy of a site document, when the store keeps one. */
  orgCopy?(path: string): Promise<Record<string, any> | null>;
}

export interface CollectionCounts { compared: number; equal: number; different: number; missing: number; dropped: number }
export interface CompareReport {
  records: number;
  equal: number;
  dropped: number;
  missing: Array<{ line: number; path: string }>;
  different: Array<{ line: number; path: string; at: string }>;
  orgCopies: { equal: number; different: Array<{ path: string; at: string }> };
  collections: Record<string, CollectionCounts>;
  errors: Array<{ line: number; path?: string; error: string }>;
}

export const emptyCompareReport = (): CompareReport => ({ records: 0, equal: 0, dropped: 0, missing: [], different: [], orgCopies: { equal: 0, different: [] }, collections: {}, errors: [] });
export const compareFailed = (report: CompareReport) => report.missing.length + report.different.length + report.orgCopies.different.length + report.errors.length > 0;

/** JSON pointer of the first difference between two JSON values, or null when equal. */
export function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (canonicalJson(a) === canonicalJson(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}/length`;
    for (let i = 0; i < a.length; i++) { const found = firstDifference(a[i], b[i], `${at}/${i}`); if (found) return found; }
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const found = firstDifference(a[key], b[key], `${at}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (found) return found;
    }
  }
  return at || '/';
}

const stripId = (value: Record<string, any> | null) => { if (!value) return null; const { id: _id, ...rest } = value; void _id; return rest; };

/** Batched reads straight from the sharded objects; never creates a site object. */
export function shardedReader(target: MigrationTarget): CompareReader {
  const owners = new Map<string, Promise<string | null>>();
  const siteShard = (org: string, site: string) => {
    let found = owners.get(`${org}:${site}`);
    if (!found) owners.set(`${org}:${site}`, found = target.transport('global').get(ownerPath(org, site)).then(owner => owner ? `site:${owner.data.uid}` : null));
    return found;
  };
  return {
    async getMany(paths) {
      const groups = new Map<string | null, number[]>();
      for (let i = 0; i < paths.length; i++) {
        const shard = shardFor(paths[i]!);
        const name = shard.kind === 'site' ? await siteShard(shard.org, shard.site) : fixedObjectName(shard);
        let group = groups.get(name);
        if (!group) groups.set(name, group = []);
        group.push(i);
      }
      const result = new Array<Record<string, any> | null>(paths.length).fill(null);
      for (const [name, indexes] of groups) {
        if (!name) continue;
        const docs = await target.transport(name).getMany(indexes.map(i => paths[i]!));
        indexes.forEach((index, i) => { result[index] = docs[i]?.data ?? null; });
      }
      return result;
    },
    async orgCopy(path) {
      // A site document's copy lives in its organization, an organization's in the global object.
      const { org } = shardFor(path) as { org: string };
      const mirror = /^organizations\/[^/]+$/.test(path) ? 'global' : `org:${org}`;
      const copy = (await target.transport(mirror).get(path))?.data;
      return copy ? stripMirrorRevision(copy) : null;
    },
  };
}

/** Reads through any store's `getDoc` (an unsharded SqlStore, Firestore, fixtures). */
export function storeReader(store: Pick<ReadWriteStore, 'getDoc'>): CompareReader {
  return { getMany: paths => Promise.all(paths.map(async path => stripId(await store.getDoc<Record<string, any>>(path)))) };
}

const counts = (report: CompareReport, path: string) =>
  report.collections[collectionGroup(path)] ??= { compared: 0, equal: 0, different: 0, missing: 0, dropped: 0 };

/** Compare numbered export lines (a chunk of the file) with the target, adding to `report`. */
export async function compareLines(reader: CompareReader, lines: Array<{ line: number; text: string }>, report: CompareReport, opts: { maxDocumentBytes?: number } = {}): Promise<void> {
  const expected: Array<{ line: number; record: ExportRecord; data: Record<string, any> }> = [];
  for (const { line, text } of lines) {
    const parsed = parseRecordLine(text);
    if ('error' in parsed) { report.errors.push({ line, error: parsed.error }); continue; }
    report.records++;
    const result = transformRecord(parsed.record, opts);
    if (result.kind === 'drop') { report.dropped++; counts(report, result.path).dropped++; continue; }
    if (result.kind === 'error') { report.errors.push({ line, path: result.path, error: result.error }); continue; }
    expected.push({ line, record: parsed.record, data: result.data });
  }
  const actual = await reader.getMany(expected.map(item => item.record.path));
  for (let i = 0; i < expected.length; i++) {
    const { line, record: { path }, data } = expected[i]!, found = actual[i] ?? null, group = counts(report, path);
    group.compared++;
    if (!found) { report.missing.push({ line, path }); group.missing++; continue; }
    const want = logicalValue(path, data);
    const at = firstDifference(want, logicalValue(path, found));
    if (at) { report.different.push({ line, path, at }); group.different++; continue; }
    report.equal++; group.equal++;
    if (reader.orgCopy && /^organizations\/[^/]+(\/sites\/[^/]+)?$/.test(path)) {
      const copy = await reader.orgCopy(path);
      const copyAt = copy ? firstDifference(want, logicalValue(path, copy)) : '/';
      if (copyAt) report.orgCopies.different.push({ path, at: copyAt });
      else report.orgCopies.equal++;
    }
  }
}
