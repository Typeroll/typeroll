// Removes expired sign-in records from the store: Better Auth sessions and
// verification tokens (portal and operator tables) and MCP authorization
// codes and refresh-token use markers. Called by the Worker's Cron trigger;
// this is housekeeping of Typeroll's own records, not a check of any site.
// A record is removed one day after it expired, so a token that is still
// being exchanged at its expiry is never touched.

import type { ReadWriteStore } from '../datastore';

const GRACE_MS = 24 * 60 * 60 * 1000;

/** Collection → expiry field (epoch milliseconds or an ISO date). */
export const EXPIRING_COLLECTIONS: Readonly<Record<string, string>> = Object.freeze({
  auth_session: 'expiresAt',
  auth_verification: 'expiresAt',
  operator_auth_session: 'expiresAt',
  operator_auth_verification: 'expiresAt',
  mcp_authorization_codes: 'expires_at',
  mcp_refresh_uses: 'expires_at',
});

function expiry(value: unknown): number | null {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

export async function removeExpiredAuthRecords(store: ReadWriteStore, now = Date.now(), limit = 200): Promise<Record<string, number>> {
  const cutoff = now - GRACE_MS;
  const removed: Record<string, number> = {};
  for (const [collection, field] of Object.entries(EXPIRING_COLLECTIONS)) {
    removed[collection] = 0;
    const expired = (await store.listDocs<Record<string, unknown>>(collection))
      .filter(doc => { const at = expiry(doc[field]); return at !== null && at < cutoff; })
      .slice(0, limit);
    for (const doc of expired) {
      // Re-read: a record renewed meanwhile stays.
      const current = await store.getDoc<Record<string, unknown>>(`${collection}/${doc.id}`);
      const at = current ? expiry(current[field]) : null;
      if (at === null || at >= cutoff) continue;
      await store.deleteDoc(`${collection}/${doc.id}`);
      removed[collection]++;
    }
  }
  return removed;
}
