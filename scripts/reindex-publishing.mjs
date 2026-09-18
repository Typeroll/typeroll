#!/usr/bin/env node
// One-time, idempotent index preparation. No builds are dispatched by this command.
// Node 22: node --experimental-strip-types scripts/reindex-publishing.mjs --project ID
import { parseArgs } from 'node:util';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldPath } from 'firebase-admin/firestore';
import { scheduledIndexWrites } from '../packages/portal/src/lib/scheduling/index.ts';

const { values } = parseArgs({ options: {
  project: { type: 'string' }, apply: { type: 'boolean', default: false }, 'confirm-project': { type: 'string' },
} });
if (!values.project || (values.apply && values['confirm-project'] !== values.project)) {
  throw new Error('Specify --project; writes also require --apply --confirm-project with the same project ID.');
}
const app = initializeApp({ projectId: values.project, credential: applicationDefault() });
const db = getFirestore(app);
const counts = { scanned: 0, eligible: 0, created: 0, existing: 0, mode: values.apply ? 'apply' : 'dry-run' };
for (const collection of ['sites', 'pages']) {
  let cursor;
  for (;;) {
    let query = db.collectionGroup(collection).orderBy(FieldPath.documentId()).limit(200);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const doc of page.docs) {
      counts.scanned++;
      const writes = scheduledIndexWrites(doc.ref.path, undefined, doc.data()).filter(write => write.data);
      if (!writes.length) continue;
      counts.eligible++;
      if (!values.apply) continue;
      const outcome = await db.runTransaction(async tx => {
        // Re-read both source and index inside the transaction. A concurrent
        // edit or completed delivery must never be overwritten by backfill.
        const source = await tx.get(doc.ref);
        if (!source.exists) return 'none';
        const write = scheduledIndexWrites(doc.ref.path, undefined, source.data()).find(write => write.data);
        if (!write) return 'none';
        const target = db.doc(write.path), existing = await tx.get(target);
        if (existing.exists) return 'existing';
        tx.create(target, write.data);
        return 'created';
      });
      if (outcome !== 'none') counts[outcome]++;
    }
    cursor = page.docs.at(-1);
  }
}
console.log(JSON.stringify(counts));
