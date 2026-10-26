// Remove the visitor IP address and browser string that older form
// submissions stored. Core 0.2.113 stopped writing them; this finds the
// documents that still carry them. No datastore access: the caller supplies
// paging and writes (scripts/scrub-submission-network-data.mjs).

const SUBMISSION_PATH = /^organizations\/[^/]+\/sites\/[^/]+\/submissions\/[^/]+$/;
export const LEGACY_NETWORK_FIELDS = Object.freeze(['submitted_from_ip', 'user_agent']);

/** The legacy fields present on a site form submission; empty for any other document. */
export function legacyNetworkFields(path, data) {
  if (!SUBMISSION_PATH.test(path) || !data || typeof data !== 'object') return [];
  return LEGACY_NETWORK_FIELDS.filter((field) => Object.hasOwn(data, field));
}

/**
 * Scan every page of submissions and, with `apply`, remove the legacy fields.
 *
 * @param {object} input
 * @param {(cursor: unknown, limit: number) => Promise<Array<{ path: string, data: object }>>} input.listPage
 *   Next page in a stable order after `cursor` (the last document of the previous page).
 * @param {(targets: Array<{ doc: { path: string }, fields: string[] }>) => Promise<{ updated: number, missing: number }>} input.update
 *   Remove `fields` from each document without recreating a deleted one.
 * @param {boolean} [input.apply]
 * @param {number} [input.batchSize]
 */
export async function scrubSubmissionNetworkFields({ listPage, update, apply = false, batchSize = 200 }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('batchSize must be a whole number from 1 to 500.');
  const counts = {
    mode: apply ? 'apply' : 'dry-run', scanned: 0, other_documents: 0, eligible: 0,
    fields: Object.fromEntries(LEGACY_NETWORK_FIELDS.map((field) => [field, 0])), updated: 0, missing: 0, batches: 0,
  };
  let cursor;
  for (;;) {
    const docs = await listPage(cursor, batchSize);
    if (!docs.length) break;
    const targets = [];
    for (const doc of docs) {
      counts.scanned++;
      if (!SUBMISSION_PATH.test(doc.path)) { counts.other_documents++; continue; }
      const fields = legacyNetworkFields(doc.path, doc.data);
      if (!fields.length) continue;
      counts.eligible++;
      for (const field of fields) counts.fields[field]++;
      targets.push({ doc, fields });
    }
    if (apply && targets.length) {
      const result = await update(targets);
      counts.updated += result.updated;
      counts.missing += result.missing;
      counts.batches++;
    }
    if (docs.length < batchSize) break;
    cursor = docs.at(-1);
  }
  return counts;
}
