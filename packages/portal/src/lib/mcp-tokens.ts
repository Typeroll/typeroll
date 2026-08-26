// JWT issuance + verification for the hosted-MCP OAuth shim.
//
// The access token Claude presents to /api/mcp is an HS256-signed JWT whose
// payload carries the underlying Typeroll API key. The signing key
// (MCP_OAUTH_SIGNING_KEY env var, mounted from Secret Manager) means
// clients can't forge tokens; verifying the JWT then handing the embedded
// api_key to verifyApiToken() picks up live revocation for free.
//
// Why embed the api_key in the JWT instead of a server-side mapping table:
// the JWT moves the lookup off the request path (no extra read on every
// MCP call). The api_key is sent only over TLS and Claude stores tokens
// encrypted-at-rest; revoking the underlying key invalidates every JWT
// minted against it because verifyApiToken consults the lookup index. The
// JWT itself never leaves the wire to a third party.
//
// Authorization codes (used for the /authorize → /token exchange) are
// separate, one-time, short-lived (10 min) JWTs carrying the same payload
// plus a `code: true` claim. The /token endpoint refuses tokens that don't
// have that claim, so an access token can't be replayed in code position.

import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from './datastore';

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL_SECONDS = 10 * 60; // 10 minutes

type TokenKind = 'access' | 'refresh' | 'code';

interface TokenPayload {
  /** The underlying typeroll_live_... key. Embedded so the MCP route can
   *  loopback into /api/v1/* without a separate store lookup. */
  api_key: string;
  /** Audience (this portal's MCP endpoint URL). RFC 8707. */
  aud: string;
  /** Token kind discriminator — prevents an access token being replayed in
   *  code position and vice versa. */
  kind: TokenKind;
  /** PKCE code_challenge — present only on `kind: 'code'` so the /token
   *  endpoint can verify the matching code_verifier. */
  pkce?: string;
  /** redirect_uri the auth code was issued for — present only on
   *  `kind: 'code'`. /token re-verifies the redirect_uri matches the
   *  one the client claims. */
  redirect_uri?: string;
  /** Issued-at and expiry (seconds since epoch). */
  iat: number;
  exp: number;
  /** Random id so two tokens minted in the same second are still distinct. */
  jti: string;
}

function getSigningKey(): Buffer {
  const raw = process.env.MCP_OAUTH_SIGNING_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'MCP_OAUTH_SIGNING_KEY is not set or is shorter than 32 chars. ' +
        'Generate one with `node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"`.',
    );
  }
  return Buffer.from(raw, 'utf8');
}

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function b64urlJSON(obj: unknown): string {
  return base64url(JSON.stringify(obj));
}

function ttlFor(kind: TokenKind): number {
  if (kind === 'access') return ACCESS_TTL_SECONDS;
  if (kind === 'refresh') return REFRESH_TTL_SECONDS;
  return CODE_TTL_SECONDS;
}

export interface IssueArgs {
  apiKey: string;
  audience: string;
  kind: TokenKind;
  /** Required when kind === 'code' — the PKCE code_challenge the client
   *  sent on /authorize. Re-verified at /token against the code_verifier. */
  pkce?: string;
  /** Required when kind === 'code' — the redirect_uri the auth flow used. */
  redirectUri?: string;
}

/** Sign and return a JWT. Audience is the portal's MCP endpoint URL. */
export function issueToken(args: IssueArgs): { token: string; expiresIn: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlFor(args.kind);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: TokenPayload = {
    api_key: args.apiKey,
    aud: args.audience,
    kind: args.kind,
    iat: now,
    exp,
    jti: crypto.randomBytes(8).toString('hex'),
    ...(args.pkce ? { pkce: args.pkce } : {}),
    ...(args.redirectUri ? { redirect_uri: args.redirectUri } : {}),
  };
  const head = b64urlJSON(header);
  const body = b64urlJSON(payload);
  const sig = crypto
    .createHmac('sha256', getSigningKey())
    .update(`${head}.${body}`)
    .digest('base64url');
  return { token: `${head}.${body}.${sig}`, expiresIn: ttlFor(args.kind) };
}

export interface VerifiedToken {
  apiKey: string;
  audience: string;
  kind: TokenKind;
  pkce?: string;
  redirectUri?: string;
  /** Token id — used by /token to enforce single-use semantics on auth
   *  codes via the mcp_consumed_codes collection. */
  jti: string;
  /** Expiry (seconds since epoch). Forwarded into the consumption record
   *  so a TTL sweep can prune it later. */
  exp: number;
}

/**
 * Verify a JWT minted by this server. Returns null on any failure —
 * including audience mismatch and expiry. Callers MUST treat null as
 * "401 invalid token" without leaking which check failed.
 */
export function verifyToken(token: string, expectedAudience?: string): VerifiedToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = crypto
    .createHmac('sha256', getSigningKey())
    .update(`${head}.${body}`)
    .digest('base64url');
  // Timing-safe compare. Both signatures are base64url so byte length matches.
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.api_key !== 'string' || !payload.api_key) return null;
  if (expectedAudience && payload.aud !== expectedAudience) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  return {
    apiKey: payload.api_key,
    audience: payload.aud,
    kind: payload.kind,
    pkce: payload.pkce,
    redirectUri: payload.redirect_uri,
    jti: payload.jti,
    exp: payload.exp,
  };
}

/**
 * PKCE S256 verification — sha256(code_verifier) base64url-encoded must
 * equal the stored code_challenge.
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto
    .createHash('sha256')
    .update(codeVerifier, 'utf8')
    .digest('base64url');
  if (computed.length !== codeChallenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
}

// ─── Signed client_id ────────────────────────────────────────────────────
//
// Dynamic Client Registration is open per the MCP auth spec — anyone can
// POST /register. But we MUST bind the registered redirect_uris to the
// returned client_id so an attacker can't reuse another client's id with
// a hijacked redirect_uri (the classic OAuth phishing pattern).
//
// We stay stateless by encoding the registered redirect_uris directly into
// the client_id and signing it with the same MCP_OAUTH_SIGNING_KEY used
// for tokens. /authorize and /complete decode the id, verify the
// signature, and require the request's redirect_uri to be in the bound
// list. Self-hosters work unchanged: each portal signs its own ids with
// its own key.
//
// Format: `mcp-<base64url(payload)>.<base64url(hmac)>`
// Payload: `{ "ru": ["https://…"], "iat": 1700000000 }`
//
// The `mcp-` prefix is cosmetic — RFC 7591 places no constraints on
// client_id shape, but keeping a visible scheme makes leaked ids
// grep-able and signals "this came from a Typeroll-flavoured server".

interface ClientIdPayload {
  /** Registered redirect URIs. /authorize requires an exact-match against
   *  this list. */
  ru: string[];
  /** Issued-at — recorded so a future "rotate signing key" migration can
   *  cut off old ids by date. Not currently enforced. */
  iat: number;
}

/**
 * Mint a `client_id` that cryptographically binds the registered
 * redirect_uris. Callers MUST treat the returned string as opaque on the
 * wire — only this module decodes it.
 */
export function signClientId(redirectUris: string[]): string {
  const payload: ClientIdPayload = {
    ru: redirectUris,
    iat: Math.floor(Date.now() / 1000),
  };
  const body = b64urlJSON(payload);
  const sig = crypto
    .createHmac('sha256', getSigningKey())
    .update(body)
    .digest('base64url');
  return `mcp-${body}.${sig}`;
}

/**
 * Verify a `client_id` and return the bound redirect URIs. Returns null on
 * any failure (unknown prefix, missing/invalid signature, malformed
 * payload). Callers MUST 400 on null without leaking which check tripped.
 */
export function parseClientId(clientId: string): { redirectUris: string[] } | null {
  if (!clientId.startsWith('mcp-')) return null;
  const rest = clientId.slice('mcp-'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  let expected: string;
  try {
    expected = crypto.createHmac('sha256', getSigningKey()).update(body).digest('base64url');
  } catch {
    return null;
  }
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload: ClientIdPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ClientIdPayload;
  } catch {
    return null;
  }
  if (!Array.isArray(payload.ru)) return null;
  const ru = payload.ru.filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (ru.length === 0) return null;
  return { redirectUris: ru };
}

/**
 * Mark an auth code's `jti` as consumed. Returns true if this caller is the
 * first to consume it (proceed); false if the code has already been used
 * (reject as replay). Backed by the datastore so the rule survives
 * across Cloud Run instances.
 *
 * Race-window note: this is a read-then-write, not a transactional
 * compare-and-set. On Firestore two near-simultaneous exchanges of the
 * same code could both find the doc absent and both succeed. PKCE +
 * audience binding already make a captured code unusable without the
 * verifier, so the single-use rule is defense-in-depth; the small race
 * window is acceptable in exchange for keeping the datastore interface
 * unchanged. If we ever want hard atomicity, add a `createDocIfMissing`
 * primitive that maps to Firestore's `create()` (fails-if-exists) and
 * to a lock+exists check on the fixtures backend.
 */
export async function consumeAuthCode(jti: string, exp: number): Promise<boolean> {
  const store = getStore();
  const path = paths.mcpConsumedCode(jti);
  const existing = await store.getDoc(path);
  if (existing) return false;
  await store.setDoc(path, {
    jti,
    exp,
    used_at: new Date().toISOString(),
  });
  return true;
}
