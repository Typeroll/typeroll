import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyNetworkFields, scrubSubmissionNetworkFields } from './lib/submission-network-scrub.mjs';

const submission = (site, id, data) => ({ path: `organizations/org/sites/${site}/submissions/${id}`, data });

/** A sorted in-memory collection group with paging like Firestore's documentId order. */
function collectionGroup(docs) {
  const sorted = [...docs].sort((a, b) => a.path.localeCompare(b.path));
  const pages = [];
  return {
    pages,
    async listPage(cursor, limit) {
      const start = cursor ? sorted.findIndex((doc) => doc.path === cursor.path) + 1 : 0;
      const page = sorted.slice(start, start + limit).map((doc) => ({ ...doc, data: { ...doc.data } }));
      pages.push(page.map((doc) => doc.path));
      return page;
    },
  };
}

test('finds the legacy fields only on site form submissions', () => {
  assert.deepEqual(legacyNetworkFields('organizations/o/sites/s/submissions/1', { submitted_from_ip: '198.51.100.1', user_agent: 'UA', data: {} }), ['submitted_from_ip', 'user_agent']);
  assert.deepEqual(legacyNetworkFields('organizations/o/sites/s/submissions/1', { user_agent: null }), ['user_agent']);
  assert.deepEqual(legacyNetworkFields('organizations/o/sites/s/submissions/1', { data: {} }), []);
  assert.deepEqual(legacyNetworkFields('organizations/o/sites/s/forms/f/submissions/1', { submitted_from_ip: 'x' }), []);
});

test('a dry run counts in batches and writes nothing', async () => {
  const group = collectionGroup([
    submission('a', '1', { submitted_from_ip: '198.51.100.1', user_agent: 'UA' }),
    submission('a', '2', { data: { email: 'x@example.com' } }),
    submission('b', '3', { user_agent: 'UA' }),
    { path: 'organizations/org/apps/x/submissions/9', data: { submitted_from_ip: '198.51.100.9' } },
    submission('c', '4', { submitted_from_ip: '198.51.100.4' }),
  ]);
  let writes = 0;
  const counts = await scrubSubmissionNetworkFields({ listPage: group.listPage, update: async () => { writes++; return { updated: 0, missing: 0 }; }, batchSize: 2 });
  assert.equal(writes, 0);
  assert.deepEqual(counts, { mode: 'dry-run', scanned: 5, other_documents: 1, eligible: 3, fields: { submitted_from_ip: 2, user_agent: 2 }, updated: 0, missing: 0, batches: 0 });
  assert.deepEqual(group.pages.map((page) => page.length), [2, 2, 1]);
});

test('apply removes only the legacy fields, page by page, and counts vanished documents', async () => {
  const group = collectionGroup([
    submission('a', '1', { submitted_from_ip: '198.51.100.1', user_agent: 'UA' }),
    submission('a', '2', { data: { email: 'x@example.com' } }),
    submission('b', '3', { user_agent: 'UA' }),
    submission('c', '4', { submitted_from_ip: '198.51.100.4' }),
  ]);
  const updates = [];
  const counts = await scrubSubmissionNetworkFields({
    apply: true, batchSize: 2, listPage: group.listPage,
    async update(targets) {
      updates.push(targets.map(({ doc, fields }) => [doc.path, fields]));
      // The last submission was deleted while the scrub ran.
      const missing = targets.filter(({ doc }) => doc.path.endsWith('/4')).length;
      return { updated: targets.length - missing, missing };
    },
  });
  assert.deepEqual(updates, [
    [['organizations/org/sites/a/submissions/1', ['submitted_from_ip', 'user_agent']]],
    [['organizations/org/sites/b/submissions/3', ['user_agent']], ['organizations/org/sites/c/submissions/4', ['submitted_from_ip']]],
  ]);
  assert.deepEqual(counts, { mode: 'apply', scanned: 4, other_documents: 0, eligible: 3, fields: { submitted_from_ip: 2, user_agent: 2 }, updated: 2, missing: 1, batches: 2 });
});

test('refuses a batch size Firestore cannot write', async () => {
  await assert.rejects(scrubSubmissionNetworkFields({ listPage: async () => [], update: async () => ({}), batchSize: 501 }), /batchSize/);
});
