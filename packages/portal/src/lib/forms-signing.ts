// HMAC-signed form submission tokens.
//
// Why: /api/forms/submit is the only public, unauthenticated endpoint that
// writes to the database (form submissions). Without a signature, anyone can
// POST arbitrary `{orgId, siteId, formId}` triples and either spam a
// submission inbox or hammer downstream action handlers (email, webhook,
// Mailchimp).
//
// The token is a base64url-encoded HMAC of `orgId.siteId.formId` with a
// platform secret. The portal generates one per form when the user views the
// form's submit URL (via `/api/sites/{siteId}/forms/{formId}/token`); the
// static site embeds it as a hidden input on the rendered form. The submit
// endpoint recomputes the HMAC and uses crypto.timingSafeEqual to compare.
//
// Token rotation: change FORMS_HMAC_SECRET. Existing static-site builds keep
// working until they're rebuilt with the new secret; this is a deliberate
// gradual-rollout property, not a bug. If you ever need a hard invalidation,
// include a "version" prefix in the signed payload and bump it.

import crypto from 'node:crypto';

const SEPARATOR = '.';

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

export function isFormsSigningConfigured(): boolean {
  const s = process.env.FORMS_HMAC_SECRET;
  return Boolean(s && s.length >= 32);
}

export function signFormToken(orgId: string, siteId: string, formId: string): string {
  const payload = `${orgId}${SEPARATOR}${siteId}${SEPARATOR}${formId}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}${SEPARATOR}${sig}`;
}

// Embed info returned alongside a form by the v1 API (read/create/update).
// Agents need both halves to build a working embed: the signed `_token`
// hidden-input value and the absolute action URL. submit_token is null when
// the server has no FORMS_HMAC_SECRET (dev without secrets) — embedding
// without it produces a form the submit endpoint will reject, so callers
// surface the null instead of silently omitting the field.
export interface FormEmbedInfo {
  submit_token: string | null;
  submit_url: string;
}

export function formEmbedInfo(orgId: string, siteId: string, formId: string): FormEmbedInfo {
  // The dedicated forms service (tr-forms / forms.typeroll.com) wins when
  // configured; the portal serves the same route as fallback (same image).
  const apiBase = (process.env.FORMS_PUBLIC_URL ?? process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  return {
    submit_token: isFormsSigningConfigured() ? signFormToken(orgId, siteId, formId) : null,
    submit_url: `${apiBase}/api/forms/submit`,
  };
}

export interface FormTokenParts {
  orgId: string;
  siteId: string;
  formId: string;
}

export function verifyFormToken(token: string): FormTokenParts | null {
  if (typeof token !== 'string') return null;
  const parts = token.split(SEPARATOR);
  if (parts.length !== 4) return null;
  const [orgId, siteId, formId, sig] = parts;
  if (!orgId || !siteId || !formId || !sig) return null;

  let expected: string;
  try {
    expected = crypto
      .createHmac('sha256', getSecret())
      .update(`${orgId}${SEPARATOR}${siteId}${SEPARATOR}${formId}`)
      .digest('base64url');
  } catch {
    return null; // secret not configured
  }

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  return { orgId, siteId, formId };
}

// ─── Forms 2.0: continuation state + proof-of-work ───────────────────────

export interface FormStateParts {
  orgId: string;
  siteId: string;
  formId: string;
  submissionId: string;
  /** Last completed step id. */
  step: string;
  /** Issued-at (ms). Server enforces a minimum interval between steps. */
  iat: number;
}

const STATE_PREFIX = 'v1';

export function signFormState(parts: Omit<FormStateParts, 'iat'> & { iat?: number }): string {
  const payload = Buffer.from(
    JSON.stringify({ ...parts, iat: parts.iat ?? Date.now() }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(`${STATE_PREFIX}.${payload}`).digest('base64url');
  return `${STATE_PREFIX}.${payload}.${sig}`;
}

export function verifyFormState(state: string): FormStateParts | null {
  if (typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 3 || parts[0] !== STATE_PREFIX) return null;
  const [prefix, payload, sig] = parts;
  let expected: string;
  try {
    expected = crypto.createHmac('sha256', getSecret()).update(`${prefix}.${payload}`).digest('base64url');
  } catch { return null; }
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FormStateParts;
    if (!d.orgId || !d.siteId || !d.formId || !d.submissionId || typeof d.iat !== 'number') return null;
    return d;
  } catch { return null; }
}

// Proof-of-work: the runtime brute-forces a nonce so
// sha256(`${token}.${bucket}.${nonce}`) has >= POW_BITS leading zero bits.
// `bucket` is a 10-minute window (floor(now/600000)) so precomputed nonces
// go stale; we accept the current and previous bucket (clock skew + slow
// fills). Verification is one hash — the asymmetry is the point.

export const POW_BITS = 15; // ~30k hashes avg ≈ <100 ms on a phone, per submission

export function verifyPow(token: string, pow: string, bits = POW_BITS): boolean {
  const m = /^(\d+)\.(\d+)$/.exec(String(pow ?? ''));
  if (!m) return false;
  const bucket = Number(m[1]);
  const nowBucket = Math.floor(Date.now() / 600_000);
  if (bucket !== nowBucket && bucket !== nowBucket - 1) return false;
  const digest = crypto.createHash('sha256').update(`${token}.${bucket}.${m[2]}`).digest();
  let zeros = 0;
  for (const byte of digest) {
    if (byte === 0) { zeros += 8; continue; }
    let b = byte;
    while ((b & 0x80) === 0) { zeros++; b = (b << 1) & 0xff; }
    break;
  }
  return zeros >= bits;
}
