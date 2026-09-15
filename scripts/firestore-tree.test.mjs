import assert from 'node:assert/strict';
import test from 'node:test';
import { walkFirestoreCollection } from './lib/firestore-tree.mjs';

test('backup walks revisions below missing version and deleted page documents', async () => {
  function collection(path, documents) {
    return { id: path.split('/').at(-1), listDocuments: async () => documents };
  }
  function document(path, data, children = []) {
    return { path, get: async () => ({ exists: data !== null, data: () => data }), listCollections: async () => children };
  }
  const revisions = collection('versions/main/pages/deleted/revisions', [document('versions/main/pages/deleted/revisions/r1', { title: 'Historical title' })]);
  const pages = collection('versions/main/pages', [document('versions/main/pages/deleted', null, [revisions]), document('versions/main/pages/live', { title: 'Live title' })]);
  const versions = collection('versions', [document('versions/main', null, [pages])]);
  const records = [];
  for await (const record of walkFirestoreCollection(versions)) records.push(record);
  assert.deepEqual(records, [
    { path: 'versions/main/pages/deleted/revisions/r1', data: { title: 'Historical title' } },
    { path: 'versions/main/pages/live', data: { title: 'Live title' } },
  ]);
});

test('backup bounds concurrent reads and keeps sorted output despite out-of-order completion', async () => {
  let active = 0, maximum = 0;
  const refs = Array.from({ length: 25 }, (_, index) => {
    const path = `records/${String(24 - index).padStart(2, '0')}`;
    return { path, listCollections: async () => [], get: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, index % 3));
      active--;
      return { exists: true, data: () => ({ index }) };
    } };
  });
  const result = [];
  for await (const doc of walkFirestoreCollection({ listDocuments: async () => refs })) result.push(doc.path);
  assert.equal(maximum, 8);
  assert.deepEqual(result, refs.map(ref => ref.path).sort());
  assert.equal(new Set(result).size, 25);
});
