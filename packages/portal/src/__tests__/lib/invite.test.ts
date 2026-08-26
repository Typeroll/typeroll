import { describe, it, expect, beforeAll } from 'vitest';
import { generateInviteToken, verifyInviteToken, extractTokenFromInput } from '../../lib/invite';

beforeAll(() => {
  process.env.FORMS_HMAC_SECRET = 'test-invite-secret-please-change-for-real-32+chars';
});

describe('generateInviteToken + verifyInviteToken', () => {
  it('round-trips a valid token', () => {
    const token = generateInviteToken('acme');
    const result = verifyInviteToken(token);
    expect(result).toEqual({ orgId: 'acme' });
  });

  it('returns null for an expired token', () => {
    // TTL of 0 means it's already expired.
    const token = generateInviteToken('acme', 0);
    expect(verifyInviteToken(token)).toBeNull();
  });

  it('returns null for a negative TTL (already expired)', () => {
    const token = generateInviteToken('acme', -1000);
    expect(verifyInviteToken(token)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(verifyInviteToken('')).toBeNull();
  });

  it('returns null for a non-base64url string', () => {
    expect(verifyInviteToken('not-a-token')).toBeNull();
  });

  it('returns null for a tampered orgId', () => {
    const token = generateInviteToken('acme');
    // Decode, tamper, re-encode
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = raw.split('::');
    parts[0] = 'evil';
    const tampered = Buffer.from(parts.join('::')).toString('base64url');
    expect(verifyInviteToken(tampered)).toBeNull();
  });

  it('returns null for a tampered expiry', () => {
    const token = generateInviteToken('acme');
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = raw.split('::');
    // Extend expiry to far future without re-signing
    parts[1] = String(Date.now() + 99 * 24 * 60 * 60 * 1000);
    const tampered = Buffer.from(parts.join('::')).toString('base64url');
    expect(verifyInviteToken(tampered)).toBeNull();
  });

  it('returns null when signed with a different secret', () => {
    const token = generateInviteToken('acme');
    process.env.FORMS_HMAC_SECRET = 'different-secret-please-change-for-real-32+chars';
    expect(verifyInviteToken(token)).toBeNull();
    // Restore
    process.env.FORMS_HMAC_SECRET = 'test-invite-secret-please-change-for-real-32+chars';
  });
});

describe('extractTokenFromInput', () => {
  it('returns the bare token unchanged', () => {
    const token = generateInviteToken('org');
    expect(extractTokenFromInput(token)).toBe(token);
  });

  it('extracts token from a full invite URL (query param)', () => {
    const token = generateInviteToken('org');
    const url = `https://app.typeroll.com/onboarding?invite=${encodeURIComponent(token)}`;
    expect(extractTokenFromInput(url)).toBe(token);
  });

  it('trims whitespace from a bare token', () => {
    const token = generateInviteToken('org');
    expect(extractTokenFromInput(`  ${token}  `)).toBe(token);
  });

  it('returns the input unchanged when URL has no invite param', () => {
    const url = 'https://app.typeroll.com/onboarding';
    expect(extractTokenFromInput(url)).toBe(url);
  });
});
