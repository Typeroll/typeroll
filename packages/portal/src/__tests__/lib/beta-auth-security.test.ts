import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { authClientAddress, limitAuthRequest, requireAuthOrigin, readAuthBody } from '../../lib/auth-request';
import { safeReturnPath } from '../../lib/return-path';
import { validRedirectUri } from '../../lib/mcp-consent';
import { getStore } from '../../lib/datastore';
import { issueToken, verifyToken, signClientId, issueAuthorizationCode, exchangeAuthorizationCode } from '../../lib/mcp-tokens';
import { POST as complete } from '../../pages/api/mcp/oauth/complete';
import { POST as token } from '../../pages/api/mcp/oauth/token';
import { listApiKeys, verifyApiToken } from '../../lib/api-keys';
const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../../lib/auth', () => ({ getSession: session }));

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  process.env.MCP_OAUTH_SIGNING_KEY = 'test-key-longer-than-thirty-two-characters';
  process.env.PORTAL_PUBLIC_URL = 'https://portal.test';
  delete process.env.AUTH_TRUST_PROXY_HOPS;
  session.mockResolvedValue({ userId: 'owner', orgId: 'acme', email: 'owner@example.test' });
  await getStore().setDoc('organizations/acme', { name: 'Acme', roles_enforced: true });
  await getStore().setDoc('organizations/acme/members/owner', { role: 'owner' });
  await getStore().setDoc('organizations/acme/sites/one', { name: 'One' });
});
const callback = 'https://client.test/callback';
const verifier = 'test-verifier-'.repeat(4);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
function fields() { return new URLSearchParams({ client_id: signClientId([callback]), redirect_uri: callback,
  code_challenge: challenge, code_challenge_method: 'S256', org_id: 'acme', site_id: 'one', decision: 'allow', state: 'opaque-state' }); }
async function approve(form = fields(), origin = 'https://portal.test') {
  const request = new Request('https://portal.test/api/mcp/oauth/complete', { method: 'POST', headers: { origin }, body: form });
  return await complete({ request, cookies: {} } as any) as Response;
}
async function exchange(body: Record<string, string>) {
  return await token({ request: new Request('https://portal.test/api/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) } as any) as Response;
}

describe('beta authentication boundaries', () => {
  it('rejects missing, cross-environment and arbitrary run.app origins', () => {
    for (const origin of ['', 'https://evil.run.app', 'https://staging.portal.test', 'http://portal.test']) {
      expect(requireAuthOrigin(new Request('https://portal.test/api/auth/session', { headers: { origin } }))?.status).toBe(403);
    }
    expect(requireAuthOrigin(new Request('https://localhost/api/auth/session', { headers: { origin: 'https://portal.test' } }))).toBeNull();
  });
  it('ignores spoofed proxy prefixes unless proxy topology is configured', () => {
    const request = new Request('https://portal.test', { headers: { 'x-forwarded-for': 'fake, client, proxy' } });
    expect(authClientAddress(request, 'socket')).toBe('socket');
    process.env.AUTH_TRUST_PROXY_HOPS = '2';
    expect(authClientAddress(request, 'socket')).toBe('client');
  });
  it('shares a rate limit across concurrent requests and resets its window', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => limitAuthRequest('user', 3, 60_000)));
    expect(results.filter(r => r === null)).toHaveLength(3);
    expect(results.filter(r => r?.status === 429)).toHaveLength(9);
    await resetDatastore();
    expect((await limitAuthRequest('user', 3))?.status).toBe(429);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    expect(await limitAuthRequest('user', 3)).toBeNull();
    vi.restoreAllMocks();
  });
  it('bounds chunked credential input before parsing', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('1234'));
      controller.enqueue(new TextEncoder().encode('5678'));
    }, cancel: cancelled });
    const request = new Request('https://portal.test', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readAuthBody(request, 6)).rejects.toThrow('too large');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await readAuthBody(new Request('https://portal.test', { method: 'POST', body: 'ok' }), 2)).toBe('ok');
  });
  it('preserves invitation and MCP continuations without allowing open redirects', () => {
    for (const path of ['/app', '/onboarding?invite=abc', '/mcp/consent?client_id=abc']) expect(safeReturnPath(path)).toBe(path);
    for (const path of ['//evil.test', '/app/../../api/auth/logout', '/mcp/consent/evil', '/onboarding\\evil', 'https://evil.test']) expect(safeReturnPath(path)).toBeNull();
  });
  it('refuses unsafe callbacks while supporting HTTPS and native clients', () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,hello', 'http://evil.test/cb', 'https://client.test/cb#secret', 'https://user:pass@client.test/cb']) expect(validRedirectUri(uri)).toBe(false);
    for (const uri of [callback, 'http://127.0.0.1:4567/callback', 'com.example.app:/callback']) expect(validRedirectUri(uri)).toBe(true);
  });
});

describe('signed-in MCP consent', () => {
  it('requires a session, same origin and administrator membership', async () => {
    expect((await approve(fields(), 'https://evil.test')).status).toBe(403);
    session.mockResolvedValueOnce(null);
    expect((await approve()).status).toBe(401);
    await getStore().setDoc('organizations/acme/members/owner', { role: 'editor' });
    expect((await approve()).status).toBe(403);
    expect(await listApiKeys('acme', 'one')).toHaveLength(0);
  });
  it('refuses cross-tenant sites, forged callback and foreign resources', async () => {
    for (const [key, value] of [['site_id', 'other-site'], ['org_id', 'other-org'], ['redirect_uri', 'https://evil.test/cb'], ['resource', 'https://other.test/api/mcp'], ['code_challenge_method', 'plain']]) {
      const form = fields(); form.set(key, value);
      expect((await approve(form)).status).toBeGreaterThanOrEqual(400);
    }
    expect(await listApiKeys('acme', 'one')).toHaveLength(0);
  });
  it('denies without creating credentials', async () => {
    const form = fields(); form.set('decision', 'deny');
    const response = await approve(form);
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(await listApiKeys('acme', 'one')).toHaveLength(0);
  });
  it('approves, exchanges, rotates and revokes a site-scoped connection on refresh replay', async () => {
    const form = fields();
    const response = await approve(form);
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.searchParams.get('state')).toBe('opaque-state');
    const body = { grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, code_verifier: verifier, redirect_uri: callback, client_id: form.get('client_id')! };
    expect((await exchange({ ...body, client_id: signClientId(['https://other.test']) })).status).toBe(400);
    const tokens = await (await exchange(body)).json();
    expect(tokens.access_token).toMatch(/^trm1_/);
    const verified = verifyToken(tokens.access_token, 'https://portal.test/api/mcp')!;
    expect(verified.kind).toBe('access');
    expect(await verifyApiToken(verified.apiKey)).toMatchObject({ orgId: 'acme', siteId: 'one' });
    expect((await exchange(body)).status).toBe(400);
    const refreshBody = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: body.client_id };
    expect((await exchange({ ...refreshBody, client_id: 'wrong' })).status).toBe(400);
    const refreshed = await (await exchange(refreshBody)).json();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect((await exchange(refreshBody)).status).toBe(400);
    expect(await verifyApiToken(verified.apiKey)).toBeNull();
  });
  it('ends access when the approving membership is removed', async () => {
    const form = fields(); const response = await approve(form);
    const tokens = await (await exchange({ grant_type: 'authorization_code', code: new URL(response.headers.get('location')!).searchParams.get('code')!, code_verifier: verifier, redirect_uri: callback, client_id: form.get('client_id')! })).json();
    const verified = verifyToken(tokens.access_token)!;
    await getStore().deleteDoc('organizations/acme/members/owner');
    expect(await verifyApiToken(verified.apiKey)).toBeNull();
  });
  it('encrypts new credentials and detects tampering, wrong audience and expiry', () => {
    const issued = issueToken({ apiKey: 'private-secret', clientId: 'client', audience: 'resource', kind: 'access' });
    expect(Buffer.from(issued.token.slice(5), 'base64url').includes(Buffer.from('private-secret'))).toBe(false);
    expect(verifyToken(issued.token, 'wrong')).toBeNull();
    expect(verifyToken(issued.token.slice(0, -10) + 'AAAAAAAAAA')).toBeNull();
    expect(verifyToken(issueToken({ apiKey: 'secret', clientId: 'client', audience: 'resource', kind: 'access', expiresAt: 1 }).token)).toBeNull();
  });
  it('binds a code to its registered client without consuming it on mismatch', async () => {
    const grant = await issueAuthorizationCode({ apiKey: 'secret', audience: 'resource', pkce: challenge, redirectUri: callback, clientId: 'one' });
    const args = { code: grant.token, audience: 'resource', codeVerifier: verifier, redirectUri: callback };
    expect(await exchangeAuthorizationCode({ ...args, clientId: 'two' })).toBeNull();
    expect(await exchangeAuthorizationCode({ ...args, clientId: 'one' })).toBe('secret');
  });
});
