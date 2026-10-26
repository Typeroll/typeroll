// Server-side sign-out for Firebase session cookies.
//
// A Firebase session cookie stays valid until it expires, so deleting it from
// the browser does not end a copy taken elsewhere. Revoking the person's
// Firebase refresh tokens would, but it also ends every other device and every
// OAuth/MCP connection (those check `tokensValidAfterTime`). Sign-out
// therefore revokes only the sign-in the cookie belongs to.
//
// A sign-in is identified by `uid` + `auth_time`. The rolling refresh re-mints
// the cookie through a custom-token exchange, which is a new Firebase sign-in
// with a new `auth_time`. Each re-minted cookie therefore records a lineage
// entry pointing at the sign-in it continues (its root). Sign-out revokes the
// root and every lineage entry of that root, so the current cookie, older
// copies and copies refreshed from them all stop working. Other sign-ins of
// the same person (other browsers and devices) have other roots.
//
// Every Firebase session read checks the denylist (one document read; the
// request already performs datastore reads for organization access). There
// is no in-process cache, so revocation applies on the next request on every
// instance. Entries expire after the longest lifetime any revoked cookie can
// still have; `expires_at` is a native timestamp for a Firestore TTL policy
// and `expires_at_ms` is checked on read, so cleanup timing never matters.

import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from './datastore';

/** Firebase's maximum session cookie lifetime. */
export const MAX_SESSION_COOKIE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
/** Clock skew allowance between this server and Firebase token issuance. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

interface RevocationRecord { revoked_at: string; expires_at: Date; expires_at_ms: number }
interface LineageRecord { root_key: string; expires_at: Date; expires_at_ms: number }

/** The key of one Firebase sign-in, or null when the claims cannot name one. */
export function signInKey(claims: { uid?: unknown; auth_time?: unknown } | null | undefined): string | null {
  if (!claims || typeof claims.uid !== 'string' || !claims.uid) return null;
  if (typeof claims.auth_time !== 'number' || !Number.isFinite(claims.auth_time)) return null;
  return crypto.createHash('sha256').update(`${claims.uid}:${claims.auth_time}`).digest('hex');
}

function expiry(now: number) {
  const ms = now + MAX_SESSION_COOKIE_LIFETIME_MS + CLOCK_SKEW_MS;
  return { expires_at: new Date(ms), expires_at_ms: ms };
}

/** Whether this sign-in was signed out. Storage errors propagate: callers fail closed. */
export async function isSignInRevoked(key: string, now = Date.now()): Promise<boolean> {
  const record = await getStore().getDoc<Partial<RevocationRecord>>(paths.revokedSession(key));
  if (!record) return false;
  // A record without a readable expiry stays effective until TTL removes it.
  return typeof record.expires_at_ms !== 'number' || record.expires_at_ms > now;
}

/** The original sign-in a (possibly refreshed) cookie continues. */
export async function signInRootKey(key: string): Promise<string> {
  const lineage = await getStore().getDoc<Partial<LineageRecord>>(paths.sessionLineage(key));
  return typeof lineage?.root_key === 'string' && KEY_PATTERN.test(lineage.root_key) ? lineage.root_key : key;
}

/**
 * Record that a re-minted cookie (childKey) continues rootKey, then confirm
 * the root was not signed out meanwhile. Sign-out writes the root first and
 * lists lineage second, so either it finds this entry or this check sees the
 * revocation. Throws when the root is revoked: the new cookie must not be set.
 */
export async function recordSignInLineage(childKey: string, rootKey: string, now = Date.now()): Promise<void> {
  if (childKey !== rootKey) {
    await getStore().setDoc(paths.sessionLineage(childKey), { root_key: rootKey, ...expiry(now) } satisfies LineageRecord);
  }
  if (await isSignInRevoked(rootKey, now)) throw new Error('Session was signed out');
}

/** Revoke the sign-in behind this key: its root, the key itself and every refreshed copy. */
export async function revokeSignIn(key: string, now = Date.now()): Promise<void> {
  const store = getStore();
  const root = await signInRootKey(key);
  const record: RevocationRecord = { revoked_at: new Date(now).toISOString(), ...expiry(now) };
  await store.setDoc(paths.revokedSession(root), record);
  const descendants = await store.listDocs<LineageRecord>(paths.sessionLineages(), {
    filters: [{ field: 'root_key', op: '==', value: root }],
  });
  const keys = new Set([key, ...descendants.map((doc) => doc.id).filter((id) => KEY_PATTERN.test(id))]);
  keys.delete(root);
  await Promise.all([...keys].map((k) => store.setDoc(paths.revokedSession(k), record)));
}
