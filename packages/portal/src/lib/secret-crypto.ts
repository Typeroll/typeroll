// Symmetric encryption for site-level integration secrets (e.g. the Postmark
// server token, SMTP password) stored in Firestore.
//
// These are MORE sensitive than ordinary site content — they grant the ability
// to send mail as the customer — so we don't rely on Firestore access control
// alone. Secrets are encrypted at rest with AES-256-GCM under an app-level key
// (INTEGRATIONS_SECRET_KEY, mounted from Secret Manager in production, the same
// pattern as MCP_OAUTH_SIGNING_KEY / FORMS_HMAC_SECRET). The key never leaves
// the server; ciphertext is what lands in the datastore.
//
// Blob format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version
// prefix lets us rotate the scheme later without guessing.

import crypto from 'node:crypto';

const SCHEME = 'v1';
const IV_BYTES = 12; // GCM standard nonce length

function getKey(): Buffer {
  const raw = process.env.INTEGRATIONS_SECRET_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'INTEGRATIONS_SECRET_KEY is not set or is shorter than 32 chars. ' +
        'Generate one with `node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"`.',
    );
  }
  // Derive a fixed 32-byte key from the configured secret so any length ≥32
  // chars works. SHA-256 of the UTF-8 bytes is deterministic and uniform.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/** True when INTEGRATIONS_SECRET_KEY is configured well enough to en/decrypt. */
export function isSecretCryptoConfigured(): boolean {
  const raw = process.env.INTEGRATIONS_SECRET_KEY;
  return Boolean(raw && raw.length >= 32);
}

/** Encrypt a plaintext secret. Returns a self-describing `v1.iv.tag.ct` blob. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SCHEME,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a blob produced by encryptSecret. Throws if the blob is malformed,
 * the scheme is unknown, or the auth tag fails (tampering / wrong key).
 */
export function decryptSecret(blob: string): string {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== SCHEME) {
    throw new Error('Malformed or unsupported secret blob');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64!, 'base64url');
  const tag = Buffer.from(tagB64!, 'base64url');
  const ct = Buffer.from(ctB64!, 'base64url');
  if (iv.length !== IV_BYTES) throw new Error('Malformed secret blob (iv)');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True if a value looks like one of our ciphertext blobs (not plaintext). */
export function isEncryptedBlob(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${SCHEME}.`);
}

/** The sentinel returned to clients in place of a stored secret. */
export const SECRET_MASK = '••••••••';

/** Returns the mask when a secret is present, undefined otherwise. */
export function maskSecret(stored: string | undefined): string | undefined {
  return stored ? SECRET_MASK : undefined;
}
