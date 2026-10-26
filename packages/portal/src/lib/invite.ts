// Organization invites.
//
// Every invite is a server-side record under
// organizations/{orgId}/invites/{inviteId}: who created it, when it expires,
// how many people may redeem it (one by default), who has, an optional email
// address it is bound to and whether it was revoked. The link carries a token
// `v2::<orgId>::<inviteId>::<sig>` (base64url) whose signature is an
// HMAC-SHA256 under a key derived from FORMS_HMAC_SECRET for invites only, so
// an invite signature can never be confused with a Forms or analytics token.
//
// Redeeming verifies the signature and then the record, and consumes one use
// atomically. Revoking the record stops the link immediately.
//
// Tokens from the earlier stateless format (`<orgId>::<expiry>::<sig>`) are
// refused: they cannot be revoked, so honouring them until expiry would keep
// a removed member's way back in for up to 30 days.

import crypto from 'node:crypto';
import { getStore } from './datastore';

const SEPARATOR = '::';
const TOKEN_VERSION = 'v2';
const INVITE_KEY_LABEL = 'typeroll/invite/v1';
const INVITE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const DEFAULT_INVITE_TTL_DAYS = 7;
export const MAX_INVITE_TTL_DAYS = 30;
export const DEFAULT_INVITE_MAX_USES = 1;
export const MAX_INVITE_MAX_USES = 50;

/** Datastore paths for invite records. */
export const invitePaths = {
  invites: (orgId: string) => `organizations/${orgId}/invites`,
  invite: (orgId: string, inviteId: string) => `organizations/${orgId}/invites/${inviteId}`,
};

export interface OrganizationInvite {
  org_id: string;
  /** The person (user id) or API key (`api_key:<prefix>`) that created it. */
  created_by: string;
  created_by_email?: string | null;
  created_at: string;
  expires_at: string;
  max_uses: number;
  used_count: number;
  /** User ids that redeemed it. */
  used_by: string[];
  revoked_at: string | null;
  revoked_by?: string | null;
  /** When set, only a signed-in person with this email address can redeem it. */
  email: string | null;
  role: 'editor';
}

export interface InviteCreator {
  id: string;
  email?: string | null;
}

function getSecret(): string {
  const secret = process.env.FORMS_HMAC_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'FORMS_HMAC_SECRET is not set or is shorter than 32 characters. ' +
        'Generate one with `node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"`.'
    );
  }
  return secret;
}

/** Invite-only signing key: HMAC-SHA256(FORMS_HMAC_SECRET, label). */
function inviteKey(): Buffer {
  return crypto.createHmac('sha256', getSecret()).update(INVITE_KEY_LABEL).digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', inviteKey()).update(payload).digest('base64url');
}

/** The signed token for an invite record. */
export function generateInviteToken(orgId: string, inviteId: string): string {
  const payload = [TOKEN_VERSION, orgId, inviteId].join(SEPARATOR);
  return Buffer.from(`${payload}${SEPARATOR}${sign(payload)}`).toString('base64url');
}

/**
 * Check an invite token's format and signature. Returns the invite it names,
 * or null. It does not consult the record: use redeemInvite to join.
 */
export function verifyInviteToken(token: string): { orgId: string; inviteId: string } | null {
  if (typeof token !== 'string' || !token || token.length > 512) return null;
  const raw = Buffer.from(token, 'base64url').toString('utf-8');
  const parts = raw.split(SEPARATOR);
  if (parts.length !== 4) return null;
  const [version, orgId, inviteId, sig] = parts;
  if (version !== TOKEN_VERSION || !orgId || orgId.includes('/') || !INVITE_ID_RE.test(inviteId) || !sig) return null;
  let expected: string;
  try {
    expected = sign([version, orgId, inviteId].join(SEPARATOR));
  } catch {
    return null; // secret not configured
  }
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  return { orgId, inviteId };
}

/**
 * Parse a token out of a raw input that may be either:
 *  - a bare token string, or
 *  - a full invite URL containing `?invite=<token>` or `#invite=<token>`.
 * Returns the token string to pass to verifyInviteToken.
 */
export function extractTokenFromInput(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('invite');
    if (fromQuery) return fromQuery;
    const hash = url.hash.replace(/^#/, '');
    const hashParams = new URLSearchParams(hash);
    const fromHash = hashParams.get('invite');
    if (fromHash) return fromHash;
  } catch {
    // Not a URL — treat the whole input as the token.
  }
  return trimmed;
}

/** Read the optional `ttlDays` (or `ttl_days`) from a request body. Same
 *  default and clamp for the session route and the public API. */
export function parseInviteTtlDays(body: unknown): number {
  const input = (body && typeof body === 'object' ? body : {}) as { ttlDays?: unknown; ttl_days?: unknown };
  const value = input.ttlDays ?? input.ttl_days;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.min(Math.round(value), MAX_INVITE_TTL_DAYS));
  }
  return DEFAULT_INVITE_TTL_DAYS;
}

export class InviteRequestError extends Error {
  readonly status = 400;
}

/** Read the optional `max_uses` (or `maxUses`) and `email` from a request
 *  body. One use and no email binding by default. */
export function parseInviteOptions(body: unknown): { ttlDays: number; maxUses: number; email: string | null } {
  const input = (body && typeof body === 'object' ? body : {}) as { max_uses?: unknown; maxUses?: unknown; email?: unknown };
  const rawUses = input.max_uses ?? input.maxUses;
  let maxUses = DEFAULT_INVITE_MAX_USES;
  if (rawUses !== undefined && rawUses !== null) {
    if (typeof rawUses !== 'number' || !Number.isInteger(rawUses) || rawUses < 1 || rawUses > MAX_INVITE_MAX_USES) {
      throw new InviteRequestError(`max_uses must be an integer from 1 to ${MAX_INVITE_MAX_USES}`);
    }
    maxUses = rawUses;
  }
  let email: string | null = null;
  if (input.email !== undefined && input.email !== null && input.email !== '') {
    if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) || input.email.length > 320) {
      throw new InviteRequestError('email must be an email address');
    }
    email = input.email.trim().toLowerCase();
  }
  return { ttlDays: parseInviteTtlDays(body), maxUses, email };
}

export interface CreatedInvite {
  inviteId: string;
  inviteUrl: string;
  expiresAt: string;
  maxUses: number;
  email: string | null;
}

/**
 * Store an invite to `orgId` and return its link. Redeeming it at
 * /onboarding, signed in as a person, adds that person to the organization
 * as an editor. Throws when the signing secret is missing; callers check
 * isFormsSigningConfigured() first to return a clear error.
 */
export async function createInvite(args: {
  orgId: string;
  ttlDays: number;
  createdBy: InviteCreator;
  maxUses?: number;
  email?: string | null;
}): Promise<CreatedInvite> {
  getSecret(); // fail before writing anything
  const inviteId = crypto.randomBytes(16).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + args.ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const record: OrganizationInvite = {
    org_id: args.orgId,
    created_by: args.createdBy.id,
    created_by_email: args.createdBy.email ?? null,
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
    max_uses: args.maxUses ?? DEFAULT_INVITE_MAX_USES,
    used_count: 0,
    used_by: [],
    revoked_at: null,
    revoked_by: null,
    email: args.email ?? null,
    role: 'editor',
  };
  if (!await getStore().createDocIfMissing(invitePaths.invite(args.orgId, inviteId), record as unknown as Record<string, unknown>)) {
    throw new Error('Invite id collision');
  }
  const token = generateInviteToken(args.orgId, inviteId);
  const baseUrl = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  return {
    inviteId,
    inviteUrl: `${baseUrl}/onboarding?invite=${encodeURIComponent(token)}`,
    expiresAt,
    maxUses: record.max_uses,
    email: record.email,
  };
}

/** Single-use invite link with the default options. Kept for callers that
 *  only choose a lifetime (the public API). */
export async function createInviteUrl(orgId: string, ttlDays: number, createdBy: InviteCreator = { id: 'unknown' }): Promise<CreatedInvite> {
  return createInvite({ orgId, ttlDays, createdBy });
}

export type InviteState = 'active' | 'expired' | 'used' | 'revoked';

export function inviteState(invite: OrganizationInvite, now = Date.now()): InviteState {
  if (invite.revoked_at) return 'revoked';
  if (!(Date.parse(invite.expires_at) > now)) return 'expired';
  if (invite.used_count >= invite.max_uses) return 'used';
  return 'active';
}

/** What an organization admin sees about an invite. Never the token. */
export function inviteSummary(invite: OrganizationInvite & { id: string }) {
  return {
    id: invite.id,
    state: inviteState(invite),
    role: invite.role,
    email: invite.email,
    created_by: invite.created_by_email ?? invite.created_by,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    max_uses: invite.max_uses,
    used_count: invite.used_count,
    revoked_at: invite.revoked_at,
  };
}

export async function listInvites(orgId: string) {
  const invites = await getStore().listDocs<OrganizationInvite>(invitePaths.invites(orgId));
  return invites
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(inviteSummary);
}

/** Revoke an invite. Returns false when there is no such invite. */
export async function revokeInvite(orgId: string, inviteId: string, revokedBy: InviteCreator): Promise<boolean> {
  if (!INVITE_ID_RE.test(inviteId)) return false;
  const path = invitePaths.invite(orgId, inviteId);
  const now = new Date().toISOString();
  const updated = await getStore().compareAndUpdateDoc<OrganizationInvite>(
    path,
    (current) => current.org_id === orgId,
    { revoked_at: now, revoked_by: revokedBy.email ?? revokedBy.id },
  );
  return updated !== null;
}

export type RedeemResult =
  | { ok: true; orgId: string }
  | { ok: false; status: 400 | 403; error: string };

const INVALID: RedeemResult = { ok: false, status: 400, error: 'Invalid or expired invite token.' };

/**
 * Verify a token against its record and join `person` to the organization.
 *
 * One use is consumed and the membership document (`member`, stored at
 * `memberPath`) is created in the same atomic write, so a use is never
 * spent without a membership and a membership never appears without a use.
 * Someone who is already a member (`alreadyMember`) is let through without
 * spending a use. A person who used the invite once and was later removed
 * cannot use it again.
 */
export async function redeemInvite(
  token: string,
  person: { userId: string; email: string },
  join: { alreadyMember: boolean; memberPath: string; member: Record<string, unknown> },
): Promise<RedeemResult> {
  const verified = verifyInviteToken(token);
  if (!verified) return INVALID;
  const store = getStore();
  const path = invitePaths.invite(verified.orgId, verified.inviteId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.getDoc<OrganizationInvite>(path);
    if (!current || current.org_id !== verified.orgId) return INVALID;
    if (current.email && current.email !== person.email.trim().toLowerCase()) {
      return { ok: false, status: 403, error: 'This invite was sent to a different email address.' };
    }
    const state = inviteState(current);
    if (state === 'revoked' || state === 'expired') return INVALID;
    if (join.alreadyMember) return { ok: true, orgId: verified.orgId };
    if (state === 'used' || current.used_by.includes(person.userId)) {
      return { ok: false, status: 400, error: 'This invite has already been used. Ask an organization admin for a new one.' };
    }
    const { id: _id, ...record } = current;
    void _id;
    const consumed = await store.compareAndReplaceDoc(
      path,
      current,
      { ...record, used_count: current.used_count + 1, used_by: [...current.used_by, person.userId] },
      [{ path: join.memberPath, data: join.member, expected: null, replace: true }],
    );
    if (consumed) return { ok: true, orgId: verified.orgId };
    // Lost a race with another redemption, a revocation or a membership
    // created meanwhile: re-read and decide again.
    join = { ...join, alreadyMember: !!await store.getDoc(join.memberPath) };
  }
  return { ok: false, status: 400, error: 'This invite could not be redeemed. Try again.' };
}
