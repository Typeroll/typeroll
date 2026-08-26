// Stateless HMAC-signed invite tokens for org membership.
//
// Token design: `<orgId>::<expiryMs>::<sig>` encoded as base64url.
// The signature is HMAC-SHA256 over `<orgId>::<expiryMs>` using the
// same FORMS_HMAC_SECRET already in Secret Manager — no new secret needed.
//
// Stateless: no Firestore doc is written. The downside is that tokens can't
// be individually revoked before expiry, but the 7-day TTL keeps the blast
// radius small and avoids an extra write + GC job.

import crypto from 'node:crypto';

const SEPARATOR = '::';

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

/** Generate a signed invite token for `orgId` that expires in `ttlMs` ms. */
export function generateInviteToken(
  orgId: string,
  ttlMs: number = 7 * 24 * 60 * 60 * 1000,
): string {
  const expiry = String(Date.now() + ttlMs);
  const payload = `${orgId}${SEPARATOR}${expiry}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const raw = `${payload}${SEPARATOR}${sig}`;
  return Buffer.from(raw).toString('base64url');
}

/** Verify an invite token. Returns `{ orgId }` on success, `null` if invalid or expired. */
export function verifyInviteToken(token: string): { orgId: string } | null {
  if (typeof token !== 'string' || !token) return null;

  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  // Split on `::` — orgId itself cannot contain `::`.
  const parts = raw.split(SEPARATOR);
  // Expect exactly 3 parts: orgId, expiry, sig
  if (parts.length !== 3) return null;
  const [orgId, expiry, sig] = parts;
  if (!orgId || !expiry || !sig) return null;

  const expiryMs = Number(expiry);
  if (!Number.isFinite(expiryMs)) return null;
  if (Date.now() >= expiryMs) return null; // expired (equal means just-expired)

  const payload = `${orgId}${SEPARATOR}${expiry}`;
  let expected: string;
  try {
    expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  } catch {
    return null; // secret not configured
  }

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  return { orgId };
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
