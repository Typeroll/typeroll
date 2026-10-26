#!/usr/bin/env node
// Audit Extension id reservations. Read-only unless --apply is given.
//
// Lists Extension ids registered by more than one developer organization
// (contested: reported only, never written) and, with --apply, reserves ids
// that have exactly one owner and no reservation yet. Writes are
// create-if-missing transactions, so a reservation claimed concurrently by the
// portal is never overwritten.
//
// node scripts/audit-extension-ids.mjs --project ID
// node scripts/audit-extension-ids.mjs --project ID --apply --confirm-project ID
import { parseArgs } from 'node:util';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { parseExtensionPath, planExtensionIdReservations } from './lib/extension-id-audit.mjs';

const { values } = parseArgs({ options: {
  project: { type: 'string' }, apply: { type: 'boolean', default: false }, 'confirm-project': { type: 'string' },
} });
if (!values.project || (values.apply && values['confirm-project'] !== values.project)) {
  throw new Error('Specify --project; writes also require --apply --confirm-project with the same project ID.');
}
const app = initializeApp({ projectId: values.project, credential: applicationDefault() });
const db = getFirestore(app);

const extensions = [];
for (const doc of (await db.collectionGroup('extensions').get()).docs) {
  const parsed = parseExtensionPath(doc.ref.path);
  if (parsed) extensions.push({ ...parsed, created_at: doc.get('created_at') });
}
const reservations = new Map((await db.collection('extension_ids').get()).docs.map(doc => [doc.id, doc.get('developer_org_id')]));
const catalog = new Map((await db.collection('extension_catalog').get()).docs.map(doc => [doc.id, doc.get('developer_org_id')]));
const plan = planExtensionIdReservations({ extensions, reservations, catalog });

const applied = { created: 0, existing: 0 };
if (values.apply) {
  for (const entry of plan.backfill) {
    const outcome = await db.runTransaction(async tx => {
      const target = db.doc(`extension_ids/${entry.extension_id}`);
      if ((await tx.get(target)).exists) return 'existing';
      tx.create(target, { extension_id: entry.extension_id, developer_org_id: entry.developer_org_id, created_at: new Date().toISOString() });
      return 'created';
    });
    applied[outcome]++;
  }
}
console.log(JSON.stringify({
  mode: values.apply ? 'apply' : 'dry-run',
  counts: {
    registrations: extensions.length,
    contested: plan.contested.length,
    backfill: plan.backfill.length,
    reserved: plan.reserved.length,
    conflicts: plan.conflicts.length,
    orphaned_reservations: plan.orphaned_reservations.length,
    ...(values.apply ? applied : {}),
  },
  contested: plan.contested,
  conflicts: plan.conflicts,
  backfill: plan.backfill,
  orphaned_reservations: plan.orphaned_reservations,
}, null, 2));
