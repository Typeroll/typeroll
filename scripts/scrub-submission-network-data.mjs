#!/usr/bin/env node
// Remove `submitted_from_ip` and `user_agent` from existing form submissions.
// Read-only unless --apply is given.
//
// Core 0.2.113 no longer stores a visitor's IP address or browser with a form
// submission, and no view returns the IP. Older submission documents
// (collection group `submissions`) still hold both fields until this runs.
// Writes are field deletes with an existence precondition, in batches, so a
// submission deleted meanwhile is never recreated and other fields are kept.
//
// node scripts/scrub-submission-network-data.mjs --project ID
// node scripts/scrub-submission-network-data.mjs --project ID --apply --confirm-project ID [--batch-size 200]
import { parseArgs } from 'node:util';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldPath, FieldValue } from 'firebase-admin/firestore';
import { LEGACY_NETWORK_FIELDS, scrubSubmissionNetworkFields } from './lib/submission-network-scrub.mjs';

const { values } = parseArgs({ options: {
  project: { type: 'string' }, apply: { type: 'boolean', default: false }, 'confirm-project': { type: 'string' },
  'batch-size': { type: 'string', default: '200' },
} });
if (!values.project || (values.apply && values['confirm-project'] !== values.project)) {
  throw new Error('Specify --project; writes also require --apply --confirm-project with the same project ID.');
}
const app = initializeApp({ projectId: values.project, credential: applicationDefault() });
const db = getFirestore(app);
const NOT_FOUND = 5;

const removal = (fields) => Object.fromEntries(fields.map((field) => [field, FieldValue.delete()]));
const counts = await scrubSubmissionNetworkFields({
  apply: values.apply,
  batchSize: Number(values['batch-size']),
  async listPage(cursor, limit) {
    // Only the two fields are read; the document order is stable for paging.
    let query = db.collectionGroup('submissions').select(...LEGACY_NETWORK_FIELDS).orderBy(FieldPath.documentId()).limit(limit);
    if (cursor) query = query.startAfter(cursor.snapshot);
    return (await query.get()).docs.map((snapshot) => ({ path: snapshot.ref.path, data: snapshot.data(), snapshot }));
  },
  async update(targets) {
    // update() requires the document to exist, so nothing deleted meanwhile is recreated.
    const batch = db.batch();
    for (const { doc, fields } of targets) batch.update(doc.snapshot.ref, removal(fields));
    try { await batch.commit(); return { updated: targets.length, missing: 0 }; }
    catch (error) {
      if (error?.code !== NOT_FOUND) throw error;
    }
    // A document in the batch was deleted: apply the rest one by one.
    let updated = 0, missing = 0;
    for (const { doc, fields } of targets) {
      try { await doc.snapshot.ref.update(removal(fields)); updated++; }
      catch (error) { if (error?.code === NOT_FOUND) missing++; else throw error; }
    }
    return { updated, missing };
  },
});
console.log(JSON.stringify(counts, null, 2));
