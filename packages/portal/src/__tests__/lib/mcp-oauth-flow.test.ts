// End-to-end OAuth shim flow: DCR → /authorize → /complete → /token →
// /api/mcp. Calls the route handlers directly (no HTTP cycle) and asserts
// the bearer JWT works as expected.

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MCP_OAUTH_SIGNING_KEY = 'test-signing-key-at-least-32-characters-long!!';
  process.env.PORTAL_PUBLIC_URL = 'https://portal.test';
});

const ORG = 'default';
const SITE = 'mysite';

async function setupSiteAndKey(): Promise<{ apiKey: string }> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'Test Site',
    hosting_adapter: 'cloudflare',
  });
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({
    orgId: ORG,
    siteId: SITE,
    name: 'test',
    createdBy: 'admin',
  });
  return { apiKey: token };
}

describe('OAuth shim — DCR', () => {
  it('returns a signed client_id binding redirect_uris', async () => {
    const mod = await import('../../pages/api/mcp/oauth/register');
    const req = new Request('https://portal.test/api/mcp/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        client_name: 'Claude',
      }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.client_id).toMatch(/^mcp-/);
    expect(data.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
    // The id verifies and decodes back to the registered redirect.
    const { parseClientId } = await import('../../lib/mcp-tokens');
    expect(parseClientId(data.client_id)?.redirectUris).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
    ]);
  });

  it('rejects when redirect_uris is empty', async () => {
    const mod = await import('../../pages/api/mcp/oauth/register');
    const req = new Request('https://portal.test/api/mcp/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [] }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(400);
  });

  it('rejects redirect_uris that do not parse as URLs', async () => {
    const mod = await import('../../pages/api/mcp/oauth/register');
    const req = new Request('https://portal.test/api/mcp/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['not a url'] }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(400);
  });
});

describe('OAuth shim — /authorize redirect binding', () => {
  it('rejects an /authorize request whose redirect_uri is not in the signed client_id', async () => {
    const { signClientId } = await import('../../lib/mcp-tokens');
    const clientId = signClientId(['https://claude.ai/api/mcp/auth_callback']);
    const mod = await import('../../pages/api/mcp/oauth/authorize');
    const url = new URL('https://portal.test/api/mcp/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', 'https://evil.example/cb');
    url.searchParams.set('code_challenge', 'xyz');
    const res = await (mod.GET as APIRoute)({ url, request: new Request(url) } as any) as Response;
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('invalid_request');
  });

  it('rejects an /authorize request whose client_id has been tampered with', async () => {
    const { signClientId } = await import('../../lib/mcp-tokens');
    const original = signClientId(['https://claude.ai/api/mcp/auth_callback']);
    // Flip a byte in the signature.
    const tampered = original.slice(0, -1) + (original.endsWith('A') ? 'B' : 'A');
    const mod = await import('../../pages/api/mcp/oauth/authorize');
    const url = new URL('https://portal.test/api/mcp/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', tampered);
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
    url.searchParams.set('code_challenge', 'xyz');
    const res = await (mod.GET as APIRoute)({ url, request: new Request(url) } as any) as Response;
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('invalid_client');
  });

  it('accepts an /authorize request when redirect_uri matches a registered URI', async () => {
    const { signClientId } = await import('../../lib/mcp-tokens');
    const clientId = signClientId(['https://claude.ai/api/mcp/auth_callback']);
    const mod = await import('../../pages/api/mcp/oauth/authorize');
    const url = new URL('https://portal.test/api/mcp/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
    url.searchParams.set('code_challenge', 'xyz');
    const res = await (mod.GET as APIRoute)({ url, request: new Request(url) } as any) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/mcp/consent');
  });

  it('redirects to the consent page with a relative Location (domain-agnostic: hosted, self-hosted, or localhost)', async () => {
    // The consent redirect must NOT bake in a server-computed absolute origin.
    // Under the Node adapter, `url.origin` falls back to bare "localhost" when
    // the served host isn't in security.allowedDomains, which produced a dead
    // https://localhost/mcp/consent link. A relative Location lets the browser
    // resolve it against whatever host it's actually on — so a self-hosted
    // deployment on its own domain works without any PORTAL_PUBLIC_URL config.
    const { signClientId } = await import('../../lib/mcp-tokens');
    const clientId = signClientId(['https://claude.ai/api/mcp/auth_callback']);
    const mod = await import('../../pages/api/mcp/oauth/authorize');
    // Simulate the broken case: request host fell back to bare localhost.
    const url = new URL('https://localhost/api/mcp/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
    url.searchParams.set('code_challenge', 'xyz');
    const res = await (mod.GET as APIRoute)({ url, request: new Request(url) } as any) as Response;
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    // Relative: starts with the path, carries no scheme/host of its own.
    expect(location.startsWith('/mcp/consent?')).toBe(true);
    // Resolved against ANY host, the browser lands on that same host's consent
    // page — never a hardcoded or localhost-fallback origin.
    const onSelfHost = new URL(location, 'https://portal.acme-self-hosted.example');
    expect(onSelfHost.host).toBe('portal.acme-self-hosted.example');
    expect(onSelfHost.pathname).toBe('/mcp/consent');
    // Query params from the /authorize request are preserved for the form POST.
    expect(onSelfHost.searchParams.get('client_id')).toBe(clientId);
    expect(onSelfHost.searchParams.get('code_challenge')).toBe('xyz');
  });
});

describe('OAuth shim — /token authorization_code grant', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('exchanges code+verifier for access/refresh tokens', async () => {
    const { apiKey } = await setupSiteAndKey();
    const verifier = 'verifier-' + crypto.randomBytes(24).toString('hex');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';

    // Mint a code as if /complete had succeeded.
    const { issueToken } = await import('../../lib/mcp-tokens');
    const { token: code } = issueToken({
      apiKey,
      audience: 'https://portal.test/api/mcp',
      kind: 'code',
      pkce: challenge,
      redirectUri,
    });

    const mod = await import('../../pages/api/mcp/oauth/token');
    const req = new Request('https://portal.test/api/mcp/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token_type).toBe('Bearer');
    expect(typeof data.access_token).toBe('string');
    expect(typeof data.refresh_token).toBe('string');
    expect(data.expires_in).toBeGreaterThan(0);
  });

  it('rejects when the code verifier does not match', async () => {
    const { apiKey } = await setupSiteAndKey();
    const challenge = crypto.createHash('sha256').update('original').digest('base64url');

    const { issueToken } = await import('../../lib/mcp-tokens');
    const { token: code } = issueToken({
      apiKey,
      audience: 'https://portal.test/api/mcp',
      kind: 'code',
      pkce: challenge,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    });

    const mod = await import('../../pages/api/mcp/oauth/token');
    const req = new Request('https://portal.test/api/mcp/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'not-the-original',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('invalid_grant');
  });

  it('rejects an access token in the code slot', async () => {
    const { apiKey } = await setupSiteAndKey();
    const { issueToken } = await import('../../lib/mcp-tokens');
    // Mint an access token, then try to use it as the authorization code.
    const { token: notACode } = issueToken({
      apiKey,
      audience: 'https://portal.test/api/mcp',
      kind: 'access',
    });
    const mod = await import('../../pages/api/mcp/oauth/token');
    const req = new Request('https://portal.test/api/mcp/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: notACode,
        code_verifier: 'whatever',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(400);
  });

  it('refresh grant re-issues an access token', async () => {
    const { apiKey } = await setupSiteAndKey();
    const { issueToken } = await import('../../lib/mcp-tokens');
    const { token: refresh } = issueToken({
      apiKey,
      audience: 'https://portal.test/api/mcp',
      kind: 'refresh',
    });
    const mod = await import('../../pages/api/mcp/oauth/token');
    const req = new Request('https://portal.test/api/mcp/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refresh,
      }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.access_token).toBe('string');
    expect(data.refresh_token).toBeUndefined();
  });

  it('refresh grant fails when the underlying key has been revoked', async () => {
    const { apiKey } = await setupSiteAndKey();
    const { parseKey, revokeApiKey } = await import('../../lib/api-keys');
    const prefix = parseKey(apiKey)!.prefix;
    await revokeApiKey(ORG, SITE, prefix);

    const { issueToken } = await import('../../lib/mcp-tokens');
    const { token: refresh } = issueToken({
      apiKey,
      audience: 'https://portal.test/api/mcp',
      kind: 'refresh',
    });
    const mod = await import('../../pages/api/mcp/oauth/token');
    const req = new Request('https://portal.test/api/mcp/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('invalid_grant');
  });
});

describe('OAuth shim — authorization codes are single-use', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('rejects a second exchange of the same authorization code', async () => {
    const { apiKey } = await setupSiteAndKey();
    const verifier = 'verifier-' + crypto.randomBytes(24).toString('hex');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';

    const { issueToken } = await import('../../lib/mcp-tokens');
    const { token: code } = issueToken({
      apiKey,
      audience: 'https://portal.test/api/mcp',
      kind: 'code',
      pkce: challenge,
      redirectUri,
    });

    const tokenMod = await import('../../pages/api/mcp/oauth/token');
    const buildReq = () =>
      new Request('https://portal.test/api/mcp/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });

    const first = await (tokenMod.POST as APIRoute)({ request: buildReq() } as any) as Response;
    expect(first.status).toBe(200);

    const second = await (tokenMod.POST as APIRoute)({ request: buildReq() } as any) as Response;
    expect(second.status).toBe(400);
    const data = await second.json();
    expect(data.error).toBe('invalid_grant');
    expect(data.error_description).toMatch(/already been used/i);
  });
});

describe('OAuth shim — /complete defense-in-depth binding', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('refuses to mint a code when the form-supplied redirect_uri is not in the signed client_id', async () => {
    const { apiKey } = await setupSiteAndKey();
    const { signClientId } = await import('../../lib/mcp-tokens');
    const clientId = signClientId(['https://claude.ai/api/mcp/auth_callback']);
    const completeMod = await import('../../pages/api/mcp/oauth/complete');

    const form = new URLSearchParams({
      api_key: apiKey,
      client_id: clientId,
      redirect_uri: 'https://evil.example/cb',
      code_challenge: 'xyz',
      state: 's',
    });
    const req = new Request('https://portal.test/api/mcp/oauth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const res = await (completeMod.POST as APIRoute)({
      request: req,
      url: new URL(req.url),
    } as any) as Response;

    // Bounces back to the consent page with an error param — never 302s to
    // the attacker's host. The Location is relative (same-origin), so it can't
    // navigate off the portal regardless of host; it preserves the form params
    // so the user can retry, and no `code` was minted.
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    expect(location.startsWith('/mcp/consent?')).toBe(true);
    const locationUrl = new URL(location, 'https://portal.test');
    expect(locationUrl.pathname).toBe('/mcp/consent');
    expect(locationUrl.searchParams.get('code')).toBeNull();
    expect(locationUrl.searchParams.get('error')).toMatch(/tampered/i);
  });
});

describe('Authorization Server Metadata', () => {
  it('advertises the right endpoints', async () => {
    const mod = await import('../../pages/.well-known/oauth-authorization-server');
    const req = new Request('https://portal.test/.well-known/oauth-authorization-server');
    const res = await (mod.GET as APIRoute)({ request: req } as any) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token_endpoint).toContain('/api/mcp/oauth/token');
    expect(data.authorization_endpoint).toContain('/api/mcp/oauth/authorize');
    expect(data.registration_endpoint).toContain('/api/mcp/oauth/register');
    expect(data.code_challenge_methods_supported).toContain('S256');
  });
});
