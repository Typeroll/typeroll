// One-time edit links: how a listed business corrects its own record without
// having a Typeroll account.
//
// The token shape is `lib/invite.ts`'s — HMAC over a payload, no session
// needed to verify — but NOT its statelessness, and that difference is the
// whole design. An invite grants org membership to someone you chose; an edit
// link goes to an address scraped out of a registry, and mail gets forwarded.
// A stored grant costs one write and one read and buys three things a
// stateless token cannot have: revocation, an audit trail, and "this link was
// already used".
//
// What the token proves is possession of a grant id, not authority over an
// item. The item and collection come from the STORED grant, never from the
// request — so a holder can't retarget a valid link at a neighbouring
// business by editing the URL.

import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { EditGrant } from '@typeroll/shared';
import { getStore } from './datastore';

/** Short by design: a link that works for a week is a link that leaks. */
export const DEFAULT_TTL_HOURS = 48;
const SEPARATOR = '::';

export class EditGrantError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'EditGrantError';
  }
}

function getSecret(): string {
  const secret = process.env.FORMS_HMAC_SECRET;
  if (!secret || secret.length < 32) {
    throw new EditGrantError('FORMS_HMAC_SECRET is not set or is too short', 500);
  }
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/**
 * `base64url(orgId::siteId::grantId::sig)`.
 *
 * The org and site travel in the token so redemption can find the grant doc
 * without a cross-tenant scan; they're inside the signature, so neither can
 * be swapped for another tenant's.
 */
export function buildGrantToken(orgId: string, siteId: string, grantId: string): string {
  const payload = [orgId, siteId, grantId].join(SEPARATOR);
  return Buffer.from(`${payload}${SEPARATOR}${sign(payload)}`).toString('base64url');
}

export function parseGrantToken(
  token: string | undefined | null,
): { orgId: string; siteId: string; grantId: string } | null {
  if (typeof token !== 'string' || !token) return null;
  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  const parts = raw.split(SEPARATOR);
  if (parts.length !== 4) return null;
  const [orgId, siteId, grantId, sig] = parts;
  const expected = sign([orgId, siteId, grantId].join(SEPARATOR));
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { orgId, siteId, grantId };
}

export async function issueGrant(args: {
  orgId: string;
  siteId: string;
  collection: string;
  itemId: string;
  email: string;
  ttlHours?: number;
  now?: Date;
}): Promise<{ grantId: string; token: string; expiresAt: string }> {
  const now = args.now ?? new Date();
  const ttl = args.ttlHours ?? DEFAULT_TTL_HOURS;
  const expiresAt = new Date(now.getTime() + ttl * 3_600_000).toISOString();
  const grantId = await getStore().addDoc(paths.editGrants(args.orgId, args.siteId), {
    collection: args.collection,
    item_id: args.itemId,
    email: args.email,
    issued_at: now.toISOString(),
    expires_at: expiresAt,
  } satisfies Omit<EditGrant, 'id'>);
  return { grantId, token: buildGrantToken(args.orgId, args.siteId, grantId), expiresAt };
}

export interface RedeemedGrant {
  orgId: string;
  siteId: string;
  grant: EditGrant;
}

/**
 * Verify a token and load its grant.
 *
 * `consume: true` marks it used — the redemption step does this, and the
 * editing session that follows rides a cookie rather than the link, so a
 * forwarded URL is dead the moment the first recipient opens it.
 */
export async function redeemGrant(
  token: string | undefined | null,
  opts: { consume?: boolean; now?: Date } = {},
): Promise<RedeemedGrant> {
  const parsed = parseGrantToken(token);
  // One message for every failure mode below: a caller learning WHICH check
  // failed learns whether a given grant id exists.
  const reject = () => { throw new EditGrantError('Invalid or expired link', 401); };
  if (!parsed) reject();
  const { orgId, siteId, grantId } = parsed!;

  const store = getStore();
  const grant = await store.getDoc<EditGrant>(paths.editGrant(orgId, siteId, grantId));
  if (!grant) reject();
  const now = opts.now ?? new Date();
  if (grant!.revoked_at) reject();
  if (grant!.used_at) reject();
  if (Date.parse(grant!.expires_at) <= now.getTime()) reject();

  if (opts.consume) {
    await store.updateDoc(paths.editGrant(orgId, siteId, grantId), {
      used_at: now.toISOString(),
    });
  }
  return { orgId, siteId, grant: grant! };
}

export async function revokeGrant(orgId: string, siteId: string, grantId: string): Promise<void> {
  await getStore().updateDoc(paths.editGrant(orgId, siteId, grantId), {
    revoked_at: new Date().toISOString(),
  });
}

/**
 * Revoke every outstanding grant for one item. The "someone forwarded the
 * mail" escape hatch, and what a portal operator reaches for after a support
 * call.
 */
export async function revokeGrantsForItem(
  orgId: string,
  siteId: string,
  collection: string,
  itemId: string,
): Promise<number> {
  const store = getStore();
  const all = await store.listDocs<EditGrant>(paths.editGrants(orgId, siteId));
  const live = all.filter(
    (g) => g.collection === collection && g.item_id === itemId && !g.revoked_at && !g.used_at,
  );
  for (const g of live) await revokeGrant(orgId, siteId, g.id);
  return live.length;
}
