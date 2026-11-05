// Firebase Authentication's modified scrypt, for passwords imported from
// `firebase auth:export`. Imported credential accounts store
// `fbscrypt$<salt>$<hash>` (both base64, as exported). The project-wide hash
// parameters stay out of the database: they come from the
// LEGACY_FIREBASE_SCRYPT secret only while imported hashes remain. A
// successful sign-in replaces the legacy hash with Better Auth's default.
//
// Algorithm (github.com/firebase/scrypt):
//   key  = scrypt(password, salt ‖ saltSeparator, N = 2^memCost, r = rounds, p = 1, 64 bytes)
//   hash = AES-256-CTR(key[0..32], iv = 0¹⁶).encrypt(signerKey)

import { createCipheriv, scrypt, timingSafeEqual } from 'node:crypto';

export const FIREBASE_SCRYPT_PREFIX = 'fbscrypt$';

export interface FirebaseScryptParams {
  /** base64 */
  signerKey: string;
  /** base64 */
  saltSeparator: string;
  rounds: number;
  memCost: number;
}

export function isFirebaseScryptHash(hash: string): boolean {
  return hash.startsWith(FIREBASE_SCRYPT_PREFIX);
}

export function formatFirebaseScryptHash(saltB64: string, hashB64: string): string {
  if (!isBase64(saltB64) || !isBase64(hashB64)) throw new Error('Firebase password hash and salt must be base64');
  return `${FIREBASE_SCRYPT_PREFIX}${saltB64}$${hashB64}`;
}

/** Parameters from LEGACY_FIREBASE_SCRYPT (JSON as printed by the Firebase console), or null. */
export function firebaseScryptParamsFromEnv(env: Record<string, string | undefined> = process.env): FirebaseScryptParams | null {
  const raw = env.LEGACY_FIREBASE_SCRYPT?.trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const params = {
    signerKey: String(parsed.signerKey ?? parsed.base64_signer_key ?? ''),
    saltSeparator: String(parsed.saltSeparator ?? parsed.base64_salt_separator ?? ''),
    rounds: Number(parsed.rounds),
    memCost: Number(parsed.memCost ?? parsed.mem_cost),
  };
  validateParams(params);
  return params;
}

function validateParams(params: FirebaseScryptParams): void {
  if (!isBase64(params.signerKey) || !params.signerKey || !isBase64(params.saltSeparator)) throw new Error('Invalid Firebase scrypt key material');
  if (!Number.isInteger(params.rounds) || params.rounds < 1 || params.rounds > 32) throw new Error('Invalid Firebase scrypt rounds');
  if (!Number.isInteger(params.memCost) || params.memCost < 1 || params.memCost > 20) throw new Error('Invalid Firebase scrypt memory cost');
}

/** Firebase's hash of `password` under `saltB64`, base64. */
export async function firebaseScryptHash(password: string, saltB64: string, params: FirebaseScryptParams): Promise<string> {
  validateParams(params);
  const salt = Buffer.concat([Buffer.from(saltB64, 'base64'), Buffer.from(params.saltSeparator, 'base64')]);
  const N = 2 ** params.memCost;
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(Buffer.from(password, 'utf8'), salt, 64,
      { N, r: params.rounds, p: 1, maxmem: 256 * N * params.rounds },
      (error, derived) => error ? reject(error) : resolve(derived));
  });
  const cipher = createCipheriv('aes-256-ctr', key.subarray(0, 32), Buffer.alloc(16, 0));
  return Buffer.concat([cipher.update(Buffer.from(params.signerKey, 'base64')), cipher.final()]).toString('base64');
}

/** Constant-time check of a `fbscrypt$` hash. False for malformed hashes or missing parameters. */
export async function verifyFirebaseScrypt(stored: string, password: string, params: FirebaseScryptParams | null): Promise<boolean> {
  if (!params || !isFirebaseScryptHash(stored)) return false;
  const [saltB64, hashB64] = stored.slice(FIREBASE_SCRYPT_PREFIX.length).split('$');
  if (!saltB64 || !hashB64 || !isBase64(saltB64) || !isBase64(hashB64)) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = Buffer.from(await firebaseScryptHash(password, saltB64, params), 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}
