import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isSecretCryptoConfigured,
  isEncryptedBlob,
  maskSecret,
  SECRET_MASK,
} from '../../lib/secret-crypto';

const KEY = 'unit-test-integrations-key-please-change-32+chars';

describe('secret-crypto', () => {
  beforeEach(() => {
    process.env.INTEGRATIONS_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.INTEGRATIONS_SECRET_KEY;
  });

  it('round-trips a secret', () => {
    const plain = 'pm-server-token-abc123';
    const blob = encryptSecret(plain);
    expect(blob).not.toContain(plain);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(decryptSecret(blob)).toBe(plain);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('fails to decrypt a tampered ciphertext', () => {
    const blob = encryptSecret('secret');
    const parts = blob.split('.');
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('fails to decrypt with a tampered auth tag', () => {
    const blob = encryptSecret('secret');
    const parts = blob.split('.');
    const tag = Buffer.from(parts[2]!, 'base64url');
    tag[0] = tag[0]! ^ 0xff;
    parts[2] = tag.toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('rejects a malformed blob', () => {
    expect(() => decryptSecret('not-a-blob')).toThrow();
    expect(() => decryptSecret('v2.a.b.c')).toThrow();
  });

  it('fails to decrypt under a different key', () => {
    const blob = encryptSecret('secret');
    process.env.INTEGRATIONS_SECRET_KEY = 'a-totally-different-key-32-characters-long!!';
    expect(() => decryptSecret(blob)).toThrow();
  });

  it('throws when the key is unset on a write', () => {
    delete process.env.INTEGRATIONS_SECRET_KEY;
    expect(isSecretCryptoConfigured()).toBe(false);
    expect(() => encryptSecret('x')).toThrow(/INTEGRATIONS_SECRET_KEY/);
  });

  it('isEncryptedBlob distinguishes ciphertext from plaintext', () => {
    expect(isEncryptedBlob(encryptSecret('x'))).toBe(true);
    expect(isEncryptedBlob('plaintext')).toBe(false);
    expect(isEncryptedBlob(undefined)).toBe(false);
  });

  it('maskSecret masks present secrets only', () => {
    expect(maskSecret('anything')).toBe(SECRET_MASK);
    expect(maskSecret(undefined)).toBeUndefined();
  });
});
