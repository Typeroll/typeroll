// JWT issuance + verification + PKCE round-trip for the MCP OAuth shim.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MCP_OAUTH_SIGNING_KEY = 'test-signing-key-at-least-32-characters-long!!';
});

const AUD = 'https://example.test/api/mcp';
const KEY = 'typeroll_live_abcdef123456_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

describe('issueToken + verifyToken', () => {
  it('round-trips an access token', async () => {
    const { issueToken, verifyToken } = await import('../../lib/mcp-tokens');
    const { token } = issueToken({ apiKey: KEY, audience: AUD, kind: 'access' });
    const verified = verifyToken(token, AUD);
    expect(verified).not.toBeNull();
    expect(verified?.apiKey).toBe(KEY);
    expect(verified?.kind).toBe('access');
  });

  it('rejects a tampered token', async () => {
    const { issueToken, verifyToken } = await import('../../lib/mcp-tokens');
    const { token } = issueToken({ apiKey: KEY, audience: AUD, kind: 'access' });
    const [h, b, _s] = token.split('.');
    // Re-sign with the wrong key — the verifier should reject.
    const evilSig = crypto.createHmac('sha256', 'wrong').update(`${h}.${b}`).digest('base64url');
    expect(verifyToken(`${h}.${b}.${evilSig}`, AUD)).toBeNull();
  });

  it('rejects audience mismatch', async () => {
    const { issueToken, verifyToken } = await import('../../lib/mcp-tokens');
    const { token } = issueToken({ apiKey: KEY, audience: AUD, kind: 'access' });
    expect(verifyToken(token, 'https://attacker.test/api/mcp')).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const { issueToken, verifyToken } = await import('../../lib/mcp-tokens');
    // Mint a token, then jump the clock past its 1-hour expiry by mutating
    // the body. The signature won't match, which is fine — what matters is
    // we don't accept past-exp.
    const { token } = issueToken({ apiKey: KEY, audience: AUD, kind: 'access' });
    const [h, b, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(b!, 'base64url').toString());
    payload.exp = Math.floor(Date.now() / 1000) - 10;
    const tampered = Buffer.from(JSON.stringify(payload)).toString('base64url');
    // Re-sign with the real key so only exp is the issue.
    const sig = crypto
      .createHmac('sha256', process.env.MCP_OAUTH_SIGNING_KEY!)
      .update(`${h}.${tampered}`)
      .digest('base64url');
    expect(verifyToken(`${h}.${tampered}.${sig}`, AUD)).toBeNull();
    // Sanity: a token with the original (unexpired) body is still good.
    expect(verifyToken(token, AUD)).not.toBeNull();
    // Use _s to avoid an unused-binding TS error on strict configs.
    void s;
  });

  it('rejects legacy authorization JWTs as bearer credentials', async () => {
    const { issueToken, verifyToken } = await import('../../lib/mcp-tokens');
    const { token } = issueToken({ apiKey: KEY, audience: AUD, kind: 'access' });
    const [head, body] = token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
    payload.kind = 'code';
    const changed = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', process.env.MCP_OAUTH_SIGNING_KEY!).update(`${head}.${changed}`).digest('base64url');
    expect(verifyToken(`${head}.${changed}.${signature}`, AUD)).toBeNull();
  });

});

describe('signClientId + parseClientId', () => {
  it('round-trips the registered redirect_uris', async () => {
    const { signClientId, parseClientId } = await import('../../lib/mcp-tokens');
    const uris = ['https://claude.ai/api/mcp/auth_callback', 'https://localhost:5173/cb'];
    const clientId = signClientId(uris);
    expect(clientId).toMatch(/^mcp-/);
    expect(parseClientId(clientId)?.redirectUris).toEqual(uris);
  });

  it('rejects an unsigned or malformed client_id', async () => {
    const { parseClientId } = await import('../../lib/mcp-tokens');
    expect(parseClientId('mcp-deadbeef')).toBeNull();
    expect(parseClientId('not-our-format')).toBeNull();
    expect(parseClientId('')).toBeNull();
  });

  it('rejects a client_id whose signature does not match', async () => {
    const { signClientId, parseClientId } = await import('../../lib/mcp-tokens');
    const original = signClientId(['https://claude.ai/cb']);
    const tampered = original.slice(0, -1) + (original.endsWith('A') ? 'B' : 'A');
    expect(parseClientId(tampered)).toBeNull();
  });

  it('rejects a client_id signed with a different key', async () => {
    const { signClientId, parseClientId } = await import('../../lib/mcp-tokens');
    const id = signClientId(['https://claude.ai/cb']);
    const prevKey = process.env.MCP_OAUTH_SIGNING_KEY;
    process.env.MCP_OAUTH_SIGNING_KEY = 'a-different-key-also-32-chars-or-more!!!';
    try {
      // Re-import to clear any cached signing-key state — although getSigningKey
      // reads env on each call, this is belt-and-braces.
      const { parseClientId: parseWithOtherKey } = await import('../../lib/mcp-tokens');
      expect(parseWithOtherKey(id)).toBeNull();
    } finally {
      process.env.MCP_OAUTH_SIGNING_KEY = prevKey;
    }
    // Original key still verifies it.
    expect(parseClientId(id)).not.toBeNull();
  });
});

describe('verifyPkce', () => {
  it('accepts a matching S256 pair', async () => {
    const { verifyPkce } = await import('../../lib/mcp-tokens');
    const verifier = 'a-randomly-chosen-code-verifier-string-of-decent-length';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('rejects a non-matching verifier', async () => {
    const { verifyPkce } = await import('../../lib/mcp-tokens');
    const challenge = crypto.createHash('sha256').update('original').digest('base64url');
    expect(verifyPkce('not-the-original', challenge)).toBe(false);
  });
});
