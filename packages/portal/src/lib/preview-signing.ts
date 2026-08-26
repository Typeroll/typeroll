// HMAC-signed preview tokens. Mints short-lived bearers an agent can paste
// into a browser-MCP / screenshot tool so the agent can SEE what its
// changes look like end-to-end without exposing a long-lived API key.
//
// The signed payload is the JSON-stringified ticket
// { org_id, site_id, version_id, exp }. The token itself is
// base64url(payload) + '.' + base64url(hmac-sha256(payload, SECRET)).
// Verification recomputes the HMAC and timing-safe-compares.
//
// Scope: the token is ONLY accepted on /preview/* routes. Leaked = somebody
// can read drafts of this site until the token's TTL lapses; not write, not
// other resources, not other sites.
//
// Secret rotation: change PREVIEW_HMAC_SECRET. Any in-flight tokens stop
// validating immediately; the agent calls POST /preview-link again and gets
// a fresh one. We split this from FORMS_HMAC_SECRET so the two flows can
// rotate independently.

import crypto from 'node:crypto';

// Default to the 24h max: preview links are paste-and-reuse working URLs
// for design/content iteration, not throwaway one-shot tokens. A whole
// working day on a single mint is the intended ergonomics; callers can pass
// a shorter ttl_seconds when they want one.
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

export interface PreviewTicket {
  org_id: string;
  site_id: string;
  version_id: string;
  /** Unix seconds when the token expires. */
  exp: number;
  /**
   * Include editor working copies (unsaved autosaved edits) in the render.
   * Signed into the token so the capability is fixed at mint time — a
   * holder of a saved-content link can't flip it to see unsaved work.
   * Absent = false (saved content only), which keeps old tokens valid.
   */
  wc?: boolean;
}

function getSecret(): string {
  const secret = process.env.PREVIEW_HMAC_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'PREVIEW_HMAC_SECRET is not set or is shorter than 32 characters. ' +
      'Generate one with `node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"`.',
    );
  }
  return secret;
}

export function isPreviewSigningConfigured(): boolean {
  const s = process.env.PREVIEW_HMAC_SECRET;
  return Boolean(s && s.length >= 32);
}

export function signPreviewTicket(args: {
  orgId: string;
  siteId: string;
  versionId: string;
  ttlSeconds?: number;
  includeWorkingCopies?: boolean;
}): { token: string; expiresAt: string } {
  const ttl = Math.max(60, Math.min(MAX_TTL_SECONDS, args.ttlSeconds ?? DEFAULT_TTL_SECONDS));
  const ticket: PreviewTicket = {
    org_id: args.orgId,
    site_id: args.siteId,
    version_id: args.versionId,
    exp: Math.floor(Date.now() / 1000) + ttl,
    ...(args.includeWorkingCopies ? { wc: true } : {}),
  };
  const payload = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return {
    token: `${payload}.${sig}`,
    expiresAt: new Date(ticket.exp * 1000).toISOString(),
  };
}

export function verifyPreviewToken(token: string | undefined | null): PreviewTicket | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  // Timing-safe compare on equal-length buffers.
  if (expected.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch {
    return null;
  }
  let ticket: PreviewTicket;
  try {
    ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PreviewTicket;
  } catch {
    return null;
  }
  if (typeof ticket?.exp !== 'number' || ticket.exp * 1000 < Date.now()) return null;
  if (typeof ticket.org_id !== 'string' || typeof ticket.site_id !== 'string' || typeof ticket.version_id !== 'string') {
    return null;
  }
  return ticket;
}
