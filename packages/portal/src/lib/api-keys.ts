// Site-scoped API keys for the public REST API.
//
// Storage uses two docs per key, written together at create time:
//
//   1. organizations/{orgId}/sites/{siteId}/api_keys/{prefix}
//        Full SiteApiKey doc — used by the settings UI to list, revoke,
//        and show last-used metadata. Site-scoped so the UI's listDocs
//        is bounded to the current site.
//
//   2. api_key_lookup/{prefix}
//        Root-level reverse index — used by the public-API auth handler
//        to resolve a presented bearer token to its owning org+site
//        without a session. Carries the minimum needed to verify:
//        { orgId, siteId, key_hash, revoked_at? }.
//
// Why two: at auth time the route handler has siteId (URL param) and the
// token (header) but NOT orgId. Without the root lookup we'd have to scan
// every org. With it, auth is one direct getDoc.
//
// Atomicity: cross-doc writes aren't transactional in either backend; the
// fixtures store does per-doc atomic file replace, Firestore is per-doc.
// If the lookup write succeeds and the metadata write fails the key works
// but is invisible in UI; if the reverse, the key is visible but doesn't
// work. Both are fail-safe (either no access, or fully revocable from the
// UI on retry). Documented here so a future refactor doesn't try to be
// clever about ordering.
//
// Key format on the wire:
//   typeroll_live_<12-hex-prefix>_<48-hex-secret>
//
// Both parts are hex-encoded so the `_` separator parses unambiguously
// (base64url contains underscores in its alphabet and would collide).
// The fixed scheme/variant prefix lets us add typeroll_test_/typeroll_admin_
// variants later without breaking parsers, and the all-hex body makes
// leaked tokens trivially grep-able in logs.

import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { SiteApiKey } from '@typeroll/shared';
import { getStore } from './datastore';

const KEY_VARIANT = 'live';
const PREFIX_BYTES = 6;  // hex-encoded → 12 chars
const SECRET_BYTES = 24; // hex-encoded → 48 chars

export interface ApiKeyLookupEntry {
  id: string;          // = prefix (auto-injected by the store)
  org_id: string;
  /**
   * Site this key is scoped to. `null` for org-scoped keys that span every
   * site in the org (and shared-in sites — resolved at request time via the
   * sharing model). The auth helper branches on null vs. set to decide
   * whether to enforce `urlSiteId === site_id` at request time.
   */
  site_id: string | null;
  key_hash: string;
  revoked_at?: string;
}

export interface NewKey {
  /** Full token including prefix. Shown to the user once. */
  token: string;
  /** Persisted doc id; the part the UI shows in the keys list. */
  prefix: string;
}

export interface ParsedKey {
  prefix: string;
  secret: string;
}

export function generateNewKey(): NewKey {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  return { token: `typeroll_${KEY_VARIANT}_${prefix}_${secret}`, prefix };
}

/**
 * Parse a `typeroll_live_<prefix>_<secret>` token. Returns null on any shape
 * deviation. The caller MUST treat null as "401 Unauthorized" without
 * leaking which part was off.
 */
export function parseKey(token: string | undefined | null): ParsedKey | null {
  if (!token) return null;
  const parts = token.split('_');
  if (parts.length !== 4) return null;
  const [scheme, variant, prefix, secret] = parts;
  if (scheme !== 'typeroll') return null;
  if (variant !== KEY_VARIANT) return null;
  if (!prefix || !secret) return null;
  return { prefix, secret };
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/** Timing-safe equality of two hex strings of the same length. */
export function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export interface CreateKeyArgs {
  orgId: string;
  /** `null` creates an org-scoped key spanning every site in the org. */
  siteId: string | null;
  name: string;
  createdBy: string;
}

export interface CreateKeyResult {
  key: SiteApiKey;
  /** The plaintext token; shown to the user once. Never returned again. */
  token: string;
}

/**
 * Path for the metadata doc. Site-scoped keys live under the site so the
 * existing /settings/api-keys page lists them; org-scoped keys live under
 * the org so a future cross-site listing has a stable home.
 */
function metaPath(orgId: string, siteId: string | null, prefix: string): string {
  return siteId === null
    ? paths.orgApiKey(orgId, prefix)
    : paths.apiKey(orgId, siteId, prefix);
}

function metaCollectionPath(orgId: string, siteId: string | null): string {
  return siteId === null ? paths.orgApiKeys(orgId) : paths.apiKeys(orgId, siteId);
}

export async function createApiKey(args: CreateKeyArgs): Promise<CreateKeyResult> {
  const { token, prefix } = generateNewKey();
  const secret = parseKey(token)!.secret;
  const keyHash = hashSecret(secret);
  const createdAt = new Date().toISOString();

  const doc: SiteApiKey = {
    id: prefix,
    name: args.name.trim() || 'Untitled key',
    key_hash: keyHash,
    created_at: createdAt,
    created_by: args.createdBy,
  };
  const lookup: ApiKeyLookupEntry = {
    id: prefix,
    org_id: args.orgId,
    site_id: args.siteId,
    key_hash: keyHash,
  };

  // Write metadata first, lookup second. If metadata fails we never created
  // a working key (good — minimal blast radius). If lookup fails the key is
  // visible in UI but doesn't auth (user retries or revokes).
  const store = getStore();
  await store.setDoc(metaPath(args.orgId, args.siteId, prefix), doc);
  await store.setDoc(paths.apiKeyLookupEntry(prefix), lookup);

  return { key: doc, token };
}

/**
 * List API keys for a site OR for an org (siteId = null → org-scoped).
 * The two listings are kept separate so a site's settings page only sees
 * its own keys and the org-wide settings page only sees org-scoped keys.
 */
export async function listApiKeys(
  orgId: string,
  siteId: string | null,
): Promise<SiteApiKey[]> {
  const docs = await getStore().listDocs<SiteApiKey>(metaCollectionPath(orgId, siteId));
  // Newest first; revoked at the bottom.
  return docs.sort((a, b) => {
    if (!!a.revoked_at !== !!b.revoked_at) return a.revoked_at ? 1 : -1;
    return (b.created_at ?? '').localeCompare(a.created_at ?? '');
  });
}

export async function revokeApiKey(
  orgId: string,
  siteId: string | null,
  prefix: string,
): Promise<void> {
  const store = getStore();
  const existing = await store.getDoc<SiteApiKey>(metaPath(orgId, siteId, prefix));
  if (!existing || existing.revoked_at) return;
  const revokedAt = new Date().toISOString();
  // Mark both. Revoke the lookup FIRST so the key stops authing the moment
  // the user clicks revoke; the metadata write afterwards is just UI state.
  const lookup = await store.getDoc<ApiKeyLookupEntry>(paths.apiKeyLookupEntry(prefix));
  if (lookup) {
    await store.setDoc(paths.apiKeyLookupEntry(prefix), { ...lookup, revoked_at: revokedAt });
  }
  await store.setDoc(metaPath(orgId, siteId, prefix), { ...existing, revoked_at: revokedAt });
}

export interface VerifiedKey {
  orgId: string;
  /** `null` for org-scoped keys; caller is responsible for resolving
   *  `allowedSiteIds` from sites + shares when this happens. */
  siteId: string | null;
  prefix: string;
}

/**
 * Verify a presented token. Pure data-layer function — Astro routes wrap
 * this in requireApiKey() (lib/api-auth.ts) for response shaping.
 *
 * Returns null on any failure mode (missing doc, revoked, bad secret).
 * Callers must NOT differentiate between failure reasons in the response
 * or they create a hash-existence oracle.
 *
 * On success the caller MAY narrow the result with an explicit site check
 * (URL siteId must equal returned siteId) — the route's "this token can
 * touch this site" decision is the caller's, not ours.
 */
export async function verifyApiToken(token: string): Promise<VerifiedKey | null> {
  const parsed = parseKey(token);
  if (!parsed) return null;
  const lookup = await getStore().getDoc<ApiKeyLookupEntry>(
    paths.apiKeyLookupEntry(parsed.prefix),
  );
  if (!lookup) return null;
  if (lookup.revoked_at) return null;
  if (!constantTimeHexEquals(lookup.key_hash, hashSecret(parsed.secret))) return null;
  return { orgId: lookup.org_id, siteId: lookup.site_id, prefix: parsed.prefix };
}

/**
 * Best-effort update of last_used_at / last_used_ip after a successful
 * request. Failure here must not affect the caller — the response is
 * already sent, we just lose one row of telemetry. Updates the
 * metadata doc (site or org collection per the key's scope), not the
 * root lookup (which only carries auth-critical fields).
 */
export async function recordKeyUse(
  orgId: string,
  siteId: string | null,
  prefix: string,
  ip?: string,
): Promise<void> {
  try {
    const store = getStore();
    const existing = await store.getDoc<SiteApiKey>(metaPath(orgId, siteId, prefix));
    if (!existing) return;
    await store.setDoc(metaPath(orgId, siteId, prefix), {
      ...existing,
      last_used_at: new Date().toISOString(),
      ...(ip ? { last_used_ip: ip } : {}),
    });
  } catch {
    /* swallow */
  }
}
