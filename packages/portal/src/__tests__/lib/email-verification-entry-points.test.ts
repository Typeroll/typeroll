// Walks the main authenticated entry points with a real (local E2E-signed)
// session whose email is unconfirmed. Nothing is mocked in the auth path: the
// gate in lib/auth.ts getSession() must reject the identity everywhere except
// the "Check your email" flow, while existing memberships stay intact.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../../lib/load-env', () => ({}));
vi.mock('../../lib/data-schema', () => ({ requireCurrentDataSchema: vi.fn() }));
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createE2ESessionCookie } from '../../lib/e2e-auth';
import { getSession, getSessionIdentity } from '../../lib/auth';
import { requireFullSession, requireSession, requireSiteAccess } from '../../lib/access';
import { generateInviteToken } from '../../lib/invite';
import { onRequest } from '../../middleware';
import { GET as listOrgs } from '../../pages/api/orgs/index';
import { POST as createOrg } from '../../pages/api/orgs/create';
import { POST as switchOrg } from '../../pages/api/orgs/switch';
import { POST as joinOrg } from '../../pages/api/orgs/invite/join';
import { GET as listOrgKeys, POST as createOrgKey } from '../../pages/api/orgs/api-keys/index';
import { POST as completeConsent } from '../../pages/api/mcp/oauth/complete';
import { POST as aiConnections } from '../../pages/api/account/ai-connections';
import { POST as resendEmail } from '../../pages/api/auth/verification-email';
import { POST as checkEmail } from '../../pages/api/auth/verification-status';

const PORTAL = 'http://127.0.0.1:4322';
const OWNER = 'typeroll-e2e-owner';
const env = { ...process.env };
let cookieValue = '';
const cookies = {
  get: (name: string) => name === 'typeroll_session' ? { value: cookieValue } : undefined,
  set: vi.fn(),
  delete: vi.fn(),
};
const post = (path: string, body: unknown = {}, type = 'application/json') => new Request(`${PORTAL}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': type, Origin: PORTAL },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const call = async (handler: unknown, context: Record<string, unknown>) =>
  await (handler as (context: unknown) => Promise<Response>)({ cookies, clientAddress: '192.0.2.10', params: {}, locals: { versionId: 'main' }, ...context });

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.NODE_ENV = 'test';
  process.env.FIREBASE_SERVICE_ACCOUNT = '';
  process.env.FIREBASE_PROJECT_ID = '';
  process.env.TYPEROLL_E2E_AUTH_SECRET = 'local-e2e-auth-secret-at-least-32-characters';
  process.env.PORTAL_PUBLIC_URL = PORTAL;
  process.env.MCP_OAUTH_SIGNING_KEY = 'unit-test-mcp-signing-secret-at-least-32-characters';
  makeTmpFixtures();
  await resetDatastore();
  await getStore().setDoc(paths.org('e2e-core'), { name: 'E2E core', roles_enforced: true });
  await getStore().setDoc(`${paths.members('e2e-core')}/${OWNER}`, { role: 'owner' });
  await getStore().setDoc(`user_organizations/${OWNER}/organizations/e2e-core`, { org_id: 'e2e-core' });
  await getStore().setDoc(paths.org('invited'), { name: 'Invited', roles_enforced: true });
  cookieValue = createE2ESessionCookie('owner', { emailVerified: false });
});
afterEach(() => {
  for (const key of ['NODE_ENV', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_PROJECT_ID', 'TYPEROLL_E2E_AUTH_SECRET', 'PORTAL_PUBLIC_URL', 'MCP_OAUTH_SIGNING_KEY'] as const) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
});

it('treats an unconfirmed identity as signed out while keeping its memberships', async () => {
  expect(await getSession(cookies as never)).toBeNull();
  expect(await getSessionIdentity(cookies as never)).toMatchObject({ userId: OWNER, emailVerified: false, orgId: undefined });
  for (const guard of [requireSession, requireFullSession]) {
    const result = await guard(cookies as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  }
  const site = await requireSiteAccess(cookies as never, 'e2e-core-site');
  expect(site.ok).toBe(false);
  expect(await getStore().getDoc(`${paths.members('e2e-core')}/${OWNER}`)).toMatchObject({ role: 'owner' });
  // The same persona with a confirmed email resolves its existing membership.
  cookieValue = createE2ESessionCookie('owner');
  expect(await getSession(cookies as never)).toMatchObject({ userId: OWNER, orgId: 'e2e-core', emailVerified: true });
  expect((await call(listOrgs, {})).status).toBe(200);
  expect((await call(listOrgKeys, {})).status).toBe(200);
});

it('cannot list, create, switch or join an Organization, or accept an invitation', async () => {
  expect((await call(listOrgs, {})).status).toBe(401);
  expect((await call(createOrg, { request: post('/api/orgs/create', { name: 'Spam Org' }) })).status).toBe(401);
  expect(await getStore().getDoc(paths.org('spam-org'))).toBeNull();
  expect((await call(switchOrg, { request: post('/api/orgs/switch', { orgId: 'e2e-core' }) })).status).toBe(401);
  expect((await call(joinOrg, { request: post('/api/orgs/invite/join', { token: generateInviteToken('invited') }) })).status).toBe(401);
  expect(await getStore().getDoc(`${paths.members('invited')}/${OWNER}`)).toBeNull();
  expect(cookies.set).not.toHaveBeenCalled();
});

it('cannot list or create API keys, approve MCP access or manage AI connections', async () => {
  expect((await call(listOrgKeys, {})).status).toBe(401);
  expect((await call(createOrgKey, { request: post('/api/orgs/api-keys', { name: 'spam' }) })).status).toBe(401);
  const consent = new URLSearchParams({ decision: 'allow', client_id: 'client', redirect_uri: 'https://client.example.test/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
  expect((await call(completeConsent, { request: post('/api/mcp/oauth/complete', consent.toString(), 'application/x-www-form-urlencoded') })).status).toBe(401);
  expect((await call(aiConnections, { request: post('/api/account/ai-connections', { prefix: 'x' }) })).status).toBe(401);
});

it('redirects application pages to "Check your email" and keeps the continuation', async () => {
  for (const [path, location] of [
    ['/app', '/verify-email'],
    ['/', '/verify-email'],
    ['/app/settings/api-keys', '/verify-email?next=%2Fapp%2Fsettings%2Fapi-keys'],
    ['/app/sites/e2e-core-site?tab=pages', '/verify-email?next=%2Fapp%2Fsites%2Fe2e-core-site%3Ftab%3Dpages'],
  ]) {
    const url = new URL(path, PORTAL);
    const redirect = vi.fn((target: string) => new Response(null, { status: 302, headers: { Location: target } }));
    const response = await onRequest({ url, request: new Request(url), cookies, locals: {}, redirect } as never, (async () => new Response('page')) as never) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(location);
  }
});

it('offers only resend (rate limited) and re-check to the unconfirmed identity', async () => {
  const resend = () => call(resendEmail, { request: post('/api/auth/verification-email', { next: '/mcp/consent?client_id=x' }) });
  for (let attempt = 0; attempt < 5; attempt++) expect((await resend()).status).toBe(202);
  const limited = await resend();
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBeTruthy();
  const status = await call(checkEmail, { request: post('/api/auth/verification-status') });
  expect(await status.json()).toEqual({ ok: true, verified: false });
  const crossSite = await call(resendEmail, { request: new Request(`${PORTAL}/api/auth/verification-email`, { method: 'POST', headers: { Origin: 'https://attacker.example.test' }, body: '{}' }) });
  expect(crossSite.status).toBe(403);
  cookieValue = '';
  process.env.NODE_ENV = 'production';
  expect((await call(checkEmail, { request: post('/api/auth/verification-status') })).status).toBe(401);
});
