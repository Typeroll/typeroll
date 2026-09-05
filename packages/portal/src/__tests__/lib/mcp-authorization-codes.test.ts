import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { issueAuthorizationCode, exchangeAuthorizationCode, signClientId, verifyToken } from '../../lib/mcp-tokens';
import { getStore } from '../../lib/datastore';
import { createApiKey, revokeApiKey } from '../../lib/api-keys';
import { POST as complete } from '../../pages/api/mcp/oauth/complete';
import { POST as exchange } from '../../pages/api/mcp/oauth/token';

const audience = 'https://portal.test/api/mcp';
const redirectUri = 'https://client.test/callback';
const codeVerifier = 'synthetic-verifier-that-is-long-enough-for-pkce';
const pkce = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
let apiKey: string;
beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.MCP_OAUTH_SIGNING_KEY = 'synthetic-signing-key-at-least-32-characters';
  process.env.PORTAL_PUBLIC_URL = 'https://portal.test';
  apiKey = (await createApiKey({ orgId: 'test-org', siteId: null, name: 'Test', createdBy: 'test-user' })).token;
});
afterEach(() => vi.restoreAllMocks());
const issue = () => issueAuthorizationCode({ apiKey, audience, pkce, redirectUri });
const redeem = (code: string, overrides = {}) => exchangeAuthorizationCode({ code, audience, redirectUri, codeVerifier, ...overrides });

it('keeps the API key out of the callback and encrypts the stored grant', async () => {
  const response = await complete({ url: new URL('https://portal.test/api/mcp/oauth/complete'), request: new Request('https://portal.test/api/mcp/oauth/complete', {
    method: 'POST', body: new URLSearchParams({
      api_key: apiKey, client_id: signClientId([redirectUri]), redirect_uri: redirectUri,
      code_challenge: pkce, state: 'test-state',
    }),
  }) } as never) as Response;
  expect(response.status).toBe(302);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const location = new URL(response.headers.get('location')!);
  const code = location.searchParams.get('code')!;
  expect(location.searchParams.get('state')).toBe('test-state');
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(verifyToken(code, audience)).toBeNull();
  expect(Buffer.from(code, 'base64url').toString()).not.toContain(apiKey);
  const id = crypto.createHash('sha256').update(code).digest('hex');
  expect(JSON.stringify(await getStore().getDoc(paths.mcpAuthorizationCode(id)))).not.toContain(apiKey);
  expect(await redeem(code)).toBe(apiKey);
  expect(await getStore().getDoc(paths.mcpAuthorizationCode(id))).toMatchObject({ consumed: true, sealed_key: null });
});

it.each([
  { codeVerifier: 'wrong' }, { redirectUri: 'https://other.test/callback' }, { audience: 'https://other.test/api/mcp' },
])('rejects mismatched bindings without consuming the code: %j', async (overrides) => {
  const { token } = await issue();
  expect(await redeem(token, overrides)).toBeNull();
  expect(await redeem(token)).toBe(apiKey);
});

it('allows exactly one simultaneous exchange and rejects replay', async () => {
  const { token } = await issue();
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => redeem(token)));
  expect(outcomes.filter(Boolean)).toEqual([apiKey]);
  expect(await redeem(token)).toBeNull();
});

it('rejects the code at its expiration boundary', async () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const { token, expiresIn } = await issue();
  vi.spyOn(Date, 'now').mockReturnValue(now + expiresIn * 1000);
  expect(await redeem(token)).toBeNull();
});

it('rejects exchange if the API key was revoked after consent', async () => {
  const { token } = await issue();
  await revokeApiKey('test-org', null, apiKey.split('_')[2]!);
  const response = await exchange({ request: new Request('https://portal.test/api/mcp/oauth/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: token, code_verifier: codeVerifier, redirect_uri: redirectUri }),
  }) } as never) as Response;
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
});
