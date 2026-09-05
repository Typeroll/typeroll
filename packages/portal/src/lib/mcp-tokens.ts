// Access and refresh tokens remain signed JWTs. Verification of the embedded
// API key checks live revocation on every use. Authorization codes are opaque
// one-time handles backed by encrypted, short-lived server-side grants.

import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from './datastore';

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL_SECONDS = 10 * 60; // 10 minutes

type TokenKind = 'access' | 'refresh';

interface TokenPayload {
  /** The underlying typeroll_live_... key. Embedded so the MCP route can
   *  loopback into /api/v1/* without a separate store lookup. */
  api_key: string;
  /** Audience (this portal's MCP endpoint URL). RFC 8707. */
  aud: string;
  /** Distinguishes access credentials from refresh credentials. */
  kind: TokenKind;
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
  return REFRESH_TTL_SECONDS;
}

export interface IssueArgs {
  apiKey: string;
  audience: string;
  kind: TokenKind;
}

/** Sign and return a JWT. Audience is the portal's MCP endpoint URL. */
export function issueToken(args: IssueArgs): { token: string; expiresIn: number } {
  if (args.kind !== 'access' && args.kind !== 'refresh') throw new Error('Unsupported token kind');
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
  /** Random token identifier. */
  jti: string;
  /** Expiry in seconds since the epoch. */
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
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.kind !== 'access' && payload.kind !== 'refresh') return null;
  if (typeof payload.api_key !== 'string' || !payload.api_key) return null;
  if (expectedAudience && payload.aud !== expectedAudience) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  return {
    apiKey: payload.api_key,
    audience: payload.aud,
    kind: payload.kind,
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

interface AuthorizationGrant {
  sealed_key: string | null;
  audience: string;
  pkce: string;
  redirect_uri: string;
  expires_at: number;
  consumed: boolean;
}

function grantEncryptionKey(): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', getSigningKey(), '', 'typeroll-oauth-code-v1', 32));
}

export async function issueAuthorizationCode(args: {
  apiKey: string; audience: string; pkce: string; redirectUri: string;
}): Promise<{ token: string; expiresIn: number }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.createHash('sha256').update(token).digest('hex');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', grantEncryptionKey(), nonce);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(args.apiKey, 'utf8'), cipher.final()]);
  const sealed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  const created = await getStore().createDocIfMissing(paths.mcpAuthorizationCode(id), {
    sealed_key: sealed,
    audience: args.audience,
    pkce: args.pkce,
    redirect_uri: args.redirectUri,
    expires_at: Date.now() + CODE_TTL_SECONDS * 1000,
    consumed: false,
  } satisfies AuthorizationGrant);
  if (!created) throw new Error('Could not reserve authorization code');
  return { token, expiresIn: CODE_TTL_SECONDS };
}

/** Validate all bindings and claim the grant in the same transaction. */
export async function exchangeAuthorizationCode(args: {
  code: string; audience: string; codeVerifier: string; redirectUri: string;
}): Promise<string | null> {
  if (typeof args.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(args.code)) return null;
  if (typeof args.codeVerifier !== 'string' || typeof args.redirectUri !== 'string') return null;
  const id = crypto.createHash('sha256').update(args.code).digest('hex');
  const grant = await getStore().compareAndUpdateDoc<AuthorizationGrant>(
    paths.mcpAuthorizationCode(id),
    (current) => !current.consumed && current.expires_at > Date.now() &&
      current.audience === args.audience && current.redirect_uri === args.redirectUri &&
      verifyPkce(args.codeVerifier, current.pkce),
    { consumed: true, sealed_key: null },
  );
  if (!grant?.sealed_key) return null;
  try {
    const sealed = Buffer.from(grant.sealed_key, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', grantEncryptionKey(), sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
