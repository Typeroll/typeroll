import { siteDocumentHash, type SiteDocuments, type UnifiedSitePlan } from './unified-site-plan';

export interface MigrationDocumentStore {
  /** Read the complete site tree, including history below deleted documents. */
  readAll(): Promise<SiteDocuments>;
  /** Atomic equality check and replacement/deletion of one document. */
  compareAndWrite(path: string, expected: Record<string, unknown> | null, next: Record<string, unknown> | null): Promise<boolean>;
  /** Serving, scheduled publishing and background writes must remain stopped. */
  assertWriteFreeze(): Promise<void>;
}
const same = (left: unknown, right: unknown) => siteDocumentHash({ value: { value: left ?? null } }) === siteDocumentHash({ value: { value: right ?? null } });

/** Resume from the same verified source backup and deterministic plan. Never
 * re-plan against half-migrated data. Each path may contain its old or new value;
 * any third value means another writer intervened and aborts the cutover. */
export async function applyUnifiedSitePlan(source: SiteDocuments, plan: UnifiedSitePlan, store: MigrationDocumentStore): Promise<{ written: number; already_applied: number }> {
  if (plan.source_hash !== siteDocumentHash(source) || plan.result_hash !== siteDocumentHash(plan.documents)) throw new Error('Migration plan or source backup was modified');
  await store.assertWriteFreeze();
  const current = await store.readAll();
  const paths = new Set([...Object.keys(source), ...Object.keys(plan.documents)]);
  for (const path of Object.keys(current)) if (!paths.has(path)) throw new Error(`Unexpected document appeared during migration: ${path}`);
  for (const path of paths) if (!same(current[path], source[path]) && !same(current[path], plan.documents[path])) throw new Error(`Document changed outside migration: ${path}`);
  // Install the completion marker only after every content write and deletion.
  const ordered = [...paths].sort((a, b) => Number(a === '_migrations/unified-pages') - Number(b === '_migrations/unified-pages') || a.localeCompare(b));
  let written = 0, already_applied = 0;
  for (const path of ordered) {
    if (same(current[path], plan.documents[path])) { already_applied++; continue; }
    await store.assertWriteFreeze();
    if (!await store.compareAndWrite(path, current[path] ?? null, plan.documents[path] ?? null)) throw new Error(`Concurrent write detected: ${path}`);
    written++;
  }
  await store.assertWriteFreeze();
  if (siteDocumentHash(await store.readAll()) !== plan.result_hash) throw new Error('Migration verification failed; keep serving stopped');
  return { written, already_applied };
}
