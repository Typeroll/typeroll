// Every way the GitHub connection can stop must leave a persisted diagnosis
// that names who must act and offers one action for the fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { claimAccount, disconnect, getConnection, openCredentials, saveConnection } from '../../lib/publishing/connections';
import {
  finishGithubConnection, githubChoices, githubSetup, resumeGithubInstallation, selectGithubOrganization,
  startGithubConnection, startGithubInstallation,
} from '../../lib/publishing/github-connection';
import { currentGithubDiagnosis, GITHUB_BLOCKER_CODES, githubBlocker, storedGithubDiagnosis, type GithubConnectionDiagnosis } from '../../lib/publishing/github-diagnosis';
import { githubSsoUrl, ProviderError } from '../../lib/publishing/providers.mjs';
import { GET as STATUS } from '../../pages/api/orgs/publishing/index';
import { GET as CALLBACK } from '../../pages/api/orgs/publishing/github/callback';
import { safeReturnPath } from '../../lib/return-path';
import { recheckGithubDiagnosis } from '../../lib/publishing/github-recheck';
import { GET as DIAGNOSIS, POST as RECHECK } from '../../pages/api/orgs/publishing/github/diagnosis';

const session = { userId: 'dev-user', email: 'dev@typeroll.local', orgId: 'default' };
const diagnosisPath = 'organizations/default/publishing_authorizations/github_diagnosis';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const permissions = { contents: 'write', administration: 'write', members: 'read' };
const owned = { id: 34, app_id: 12, account: { id: 56, login: 'owned-org', type: 'Organization' }, repository_selection: 'all', suspended_at: null, permissions };
const memberOnly = { id: 35, app_id: 12, account: { id: 57, login: 'member-org', type: 'Organization' }, repository_selection: 'all', suspended_at: null, permissions };
const personal = { id: 36, app_id: 12, account: { id: 78, login: 'synthetic-owner', type: 'User' }, repository_selection: 'all', suspended_at: null, permissions: { contents: 'write', administration: 'write' } };
const expiring = { access_token: 'synthetic-user-token', refresh_token: 'synthetic-refresh-token', expires_in: 28800, refresh_token_expires_in: 15897600 };
const admin = (org: number) => ({ state: 'active', role: 'admin', user: { id: 78 }, organization: { id: org } });

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  for (const [name, value] of Object.entries({ INTEGRATIONS_SECRET_KEY: 'synthetic-encryption-key-for-tests-only-32chars', PORTAL_PUBLIC_URL: 'http://localhost',
    TYPEROLL_PUBLISH_GITHUB_APP_ID: '12', TYPEROLL_PUBLISH_GITHUB_CLIENT_ID: 'synthetic-client', TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET: 'synthetic-client-secret',
    TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY: privateKey, TYPEROLL_PUBLISH_GITHUB_APP_SLUG: 'synthetic-publisher' })) vi.stubEnv(name, value);
  await getStore().setDoc('organizations/default/members/dev-user', { role: 'owner' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function providerFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    const results: Record<string, unknown> = {
      '/login/oauth/access_token': expiring,
      '/user': { id: 78, login: 'synthetic-owner' },
      '/user/installations?per_page=100&page=1': { installations: [owned] },
      '/orgs/owned-org/memberships/synthetic-owner': admin(56),
      '/orgs/member-org/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 57 } },
      '/app': { id: 12, permissions },
      '/app/installations/34': owned, '/app/installations/34/access_tokens': { token: 'synthetic-installation-token' },
      '/app/installations/35': memberOnly, '/app/installations/35/access_tokens': { token: 'synthetic-installation-token' },
      '/app/installations/36': personal, '/app/installations/36/access_tokens': { token: 'synthetic-installation-token' },
      '/orgs/owned-org': { id: 56 }, '/orgs/member-org': { id: 57 }, '/users/synthetic-owner': { id: 78, type: 'User' },
      ...overrides,
    };
    expect(init?.redirect).toBe('error');
    const key = target.pathname + target.search;
    if (!(key in results)) throw new Error(`Unexpected provider request ${key}`);
    const result = results[key];
    return result instanceof Response ? result : Response.json(result);
  });
}
const installations = (...items: unknown[]) => ({ '/user/installations?per_page=100&page=1': { installations: items } });

async function attempt(overrides: Record<string, unknown> = {}) {
  const started = await startGithubConnection(session);
  const input = { browser: started.browser, state: new URL(started.url).searchParams.get('state')!, code: 'synthetic-code' };
  try { return { result: await finishGithubConnection(session, input, providerFetch(overrides)), error: null }; }
  catch (error) { return { result: null, error: error as Error & { code?: string; diagnosis?: GithubConnectionDiagnosis } }; }
}
async function stored() { return (await currentGithubDiagnosis('default', session)); }
const blockers = (diagnosis: GithubConnectionDiagnosis, installationId: string) => diagnosis.installations.find(item => item.installation_id === installationId)!.blockers.map(item => item.code);

function routeContext(search = '', cookie?: string) {
  const url = new URL(`http://localhost/api/orgs/publishing/github/callback${search}`);
  return { url, params: { provider: 'github' }, cookies: { get: vi.fn((name: string) => name === 'typeroll_publishing_github' && cookie ? { value: cookie } : undefined), set: vi.fn(), delete: vi.fn() },
    request: new Request(url) };
}
const call = async (route: APIRoute, context: ReturnType<typeof routeContext>) => await route(context as unknown as Parameters<APIRoute>[0]) as Response;

describe('GitHub connection diagnosis', () => {
  it('explains the incident: owner of an organization without the App, member of one with it', async () => {
    const { error } = await attempt(installations(memberOnly));
    expect(error).toBeTruthy();
    const diagnosis = await stored();
    expect(diagnosis).toMatchObject({ outcome: 'action_required', github_user: { id: '78', login: 'synthetic-owner' }, attempted_by: 'dev-user',
      primary_action: { kind: 'install', url: 'https://github.com/apps/synthetic-publisher/installations/new' } });
    expect(diagnosis.blockers.map(item => item.code)).toEqual(['no_installation']);
    const row = diagnosis.installations[0];
    expect(row).toMatchObject({ installation_id: '35', account: { login: 'member-org', type: 'Organization', id: '57' }, usable: false });
    expect(row.blockers).toEqual([expect.objectContaining({ code: 'not_org_owner', who: 'github_owner',
      action: { kind: 'link', label: 'See who owns member-org', url: 'https://github.com/orgs/member-org/people?query=role%3Aowner' } })]);
    expect(row.blockers[0].message).toContain('@synthetic-owner is not an owner of member-org');
    // The card reads it from the status endpoint; nothing secret is stored or returned.
    const status = await (await call(STATUS, routeContext())).json();
    expect(status.github_diagnosis).toEqual(diagnosis);
    const raw = JSON.stringify(await getStore().getDoc(diagnosisPath));
    for (const secret of ['synthetic-user-token', 'synthetic-refresh-token', 'synthetic-installation-token', 'synthetic-client-secret', 'synthetic-code']) expect(raw).not.toContain(secret);
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
  });

  it('keeps connecting a valid personal installation when an SSO organization refuses membership', async () => {
    const sso = new Response(JSON.stringify({ message: 'synthetic-provider-body' }), { status: 403,
      headers: { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/owned-org/sso?authorization_request=synthetic' } });
    const { result } = await attempt({ ...installations(owned, personal), '/orgs/owned-org/memberships/synthetic-owner': sso });
    expect(result).toBe('connected');
    expect((await getConnection('default', 'github')).github).toMatchObject({ account_type: 'User', installation_id: '36' });
    const diagnosis = await stored();
    expect(diagnosis.outcome).toBe('connected');
    expect(diagnosis.installations.find(item => item.installation_id === '34')!.blockers).toEqual([expect.objectContaining({ code: 'sso_authorization_required', who: 'you',
      action: expect.objectContaining({ kind: 'link', url: 'https://github.com/orgs/owned-org/sso?authorization_request=synthetic' }) })]);
    expect(JSON.stringify(diagnosis)).not.toContain('synthetic-provider-body');
  });

  it('accepts only github.com HTTPS pages from X-GitHub-SSO', () => {
    expect(githubSsoUrl('required; url=https://github.com/orgs/a/sso?authorization_request=x')).toBe('https://github.com/orgs/a/sso?authorization_request=x');
    for (const value of ['required; url=https://evil.example/sso', 'required; url=http://github.com/orgs/a/sso', 'required; url=https://github.com.evil.example/',
      'required; url=https://user@github.com/', 'required; url=javascript:alert(1)', 'partial-results; organizations=1,2', null]) expect(githubSsoUrl(value)).toBeNull();
    expect(new ProviderError('GitHub', 403, [], { ssoUrl: 'required; url=https://evil.example/' }).ssoUrl).toBeNull();
  });

  it.each([
    ['rate limit', new Response('{}', { status: 429, headers: { 'Retry-After': '42' } }), 'github_rate_limited', 42],
    ['primary rate limit', new Response('{}', { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 90) } }), 'github_rate_limited', 90],
    ['outage', new Response('{}', { status: 502 }), 'github_unavailable', undefined],
  ])('reports a GitHub %s as retryable without consuming more than the sign-in', async (_name, response, code, retryAfter) => {
    const { error } = await attempt({ '/user/installations?per_page=100&page=1': response });
    expect(error?.code).toBe(code);
    const diagnosis = await stored();
    expect(diagnosis.outcome).toBe('retryable_error');
    expect(diagnosis.blockers[0]).toMatchObject({ code, who: 'you', action: { kind: 'sign_in' } });
    if (retryAfter) expect(Math.abs(diagnosis.blockers[0].retry_after! - retryAfter)).toBeLessThanOrEqual(2);
  });

  it('reports one failing organization without hiding the others', async () => {
    const second = { ...memberOnly, account: { ...memberOnly.account, login: 'flaky-org' } };
    const { result } = await attempt({ ...installations(second, owned), '/orgs/flaky-org/memberships/synthetic-owner': new Response('{}', { status: 503 }) });
    expect(result).toBe('connected');
    expect(blockers(await stored(), '35')).toEqual(['github_unavailable']);
  });

  it('records cancellation, expired and foreign-browser returns from the callback', async () => {
    const cancelling = await startGithubConnection(session);
    const cancelled = await call(CALLBACK, routeContext(`?error=access_denied&error_description=synthetic-provider-text&state=${new URL(cancelling.url).searchParams.get('state')}`, cancelling.browser));
    expect(cancelled.headers.get('location')).toBe('/app/settings/publishing?github=sign_in_required#github');
    expect((await stored()).blockers).toEqual([expect.objectContaining({ code: 'oauth_cancelled', action: { kind: 'sign_in', label: 'Sign in to GitHub' } })]);
    expect(JSON.stringify(await stored())).not.toContain('synthetic-provider-text');
    const started = await startGithubConnection(session);
    const state = new URL(started.url).searchParams.get('state')!;
    await call(CALLBACK, routeContext(`?code=synthetic-code&state=${state}`, 'y'.repeat(43)));
    expect((await stored()).blockers[0].code).toBe('wrong_browser');
    await call(CALLBACK, routeContext(`?code=synthetic-code&state=${state}`));
    expect((await stored()).blockers[0].code).toBe('wrong_browser');
    await getStore().updateDoc('organizations/default/publishing_authorizations/github', { expires_at: Date.now() - 1 });
    await call(CALLBACK, routeContext(`?code=synthetic-code&state=${state}`, started.browser));
    expect((await stored()).blockers[0]).toMatchObject({ code: 'state_expired', who: 'you', action: { kind: 'sign_in' } });
  });

  it('sends a callback without a Typeroll session to sign-in with a safe return address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const context = routeContext('?code=synthetic-code&state=x');
    const response = await call(CALLBACK, context);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!, 'http://localhost');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/app/settings/publishing?github=session_expired#github');
    expect(response.headers.get('location')).not.toContain('synthetic-code');
    expect(context.cookies.delete).toHaveBeenCalled();
    expect(safeReturnPath(location.searchParams.get('next'))).toBe('/app/settings/publishing?github=session_expired#github');
    for (const unsafe of ['//evil.example/app/', 'https://evil.example/app/', '/app/\\evil', '/login', '/app/../api/x']) expect(safeReturnPath(unsafe)).toBeNull();
  });

  it.each([
    ['limited repositories', { ...owned, repository_selection: 'selected' }, 'repository_selection_limited', 'https://github.com/organizations/owned-org/settings/installations/34', 'you'],
    ['suspension', { ...owned, suspended_at: '2026-09-01' }, 'installation_suspended', 'https://github.com/organizations/owned-org/settings/installations/34', 'you'],
    ['missing Members access', { ...owned, permissions: { contents: 'write', administration: 'write' } }, 'membership_unverifiable', 'https://github.com/organizations/owned-org/settings/installations/34/permissions/update', 'github_owner'],
    ['pending permissions', { ...owned, permissions: { ...permissions, administration: 'read' } }, 'permissions_update_pending', 'https://github.com/organizations/owned-org/settings/installations/34/permissions/update', 'you'],
  ])('explains %s on an owned organization with a direct link', async (_name, installation, code, url, who) => {
    await attempt(installations(installation));
    const diagnosis = await stored();
    expect(diagnosis.outcome).toBe('action_required');
    expect(diagnosis.installations[0].blockers[0]).toMatchObject({ code, who, action: { kind: 'link', url } });
    if (who === 'you') expect(diagnosis.primary_action).toMatchObject({ url });
    // Ownership was proven, so "install somewhere you own" would be misleading.
    if (who === 'you') expect(diagnosis.blockers).toEqual([]);
  });

  it('attributes permissions the App never requests to the publisher', async () => {
    await attempt({ ...installations({ ...owned, permissions: { ...permissions, administration: 'read' } }), '/app': { id: 12, permissions: { contents: 'write', members: 'read' } } });
    expect((await stored()).installations[0].blockers[0]).toMatchObject({ code: 'permissions_missing', who: 'publisher', action: { kind: 'contact_publisher' } });
  });

  it('explains another person’s personal account and an account claimed by another Typeroll organization', async () => {
    const someone = { ...personal, id: 37, account: { id: 99, login: 'someone-else', type: 'User' } };
    await claimAccount('another-org', 'github', '56');
    await attempt(installations(someone, owned));
    const diagnosis = await stored();
    expect(diagnosis.installations.find(item => item.installation_id === '37')!.blockers[0]).toMatchObject({ code: 'other_users_personal_account', action: { kind: 'switch_account' } });
    expect(diagnosis.installations.find(item => item.installation_id === '34')!.blockers[0]).toMatchObject({ code: 'claimed_by_other_organization', who: 'typeroll_admin' });
  });

  it('asks for an installation when none is visible and waits for an owner after an installation request', async () => {
    const { error } = await attempt(installations());
    expect(error?.code).toBe('no_installation');
    expect((await stored()).primary_action).toMatchObject({ kind: 'install' });
    const started = await startGithubInstallation(session);
    const state = new URL(started.url).searchParams.get('state')!;
    const response = await call(CALLBACK, routeContext(`?state=${state}&setup_action=request&installation_id=999`, started.browser));
    expect(response.headers.get('location')).toBe('/app/settings/publishing?github=waiting_on_owner#github');
    expect((await stored())).toMatchObject({ outcome: 'waiting_on_owner', blockers: [expect.objectContaining({ code: 'install_request_pending', who: 'github_owner' })] });
    // The request path never starts OAuth or trusts the installation id.
    await expect(resumeGithubInstallation(session, { state, browser: started.browser })).rejects.toMatchObject({ code: 'state_expired' });
  });

  it.each([
    ['install', 'installation_returned'], ['update', 'installation_returned'], ['request', 'install_requested'], [null, 'installation_returned'],
  ])('trusts nothing from a setup return without a matching state (setup_action=%s)', async (setupAction, returned) => {
    await attempt(installations());
    const started = await startGithubInstallation(session);
    const grantPath = 'organizations/default/publishing_authorizations/github';
    const grant = await getStore().getDoc(grantPath);
    const before = await getStore().getDoc(diagnosisPath);
    const query = `installation_id=999${setupAction ? `&setup_action=${setupAction}` : ''}`;
    // Installed from GitHub directly: no state at all.
    const direct = routeContext(`?${query}`, started.browser);
    expect((await call(CALLBACK, direct)).headers.get('location')).toBe(`/app/settings/publishing?github=${returned}#github`);
    expect(direct.cookies.delete).not.toHaveBeenCalled();
    // An installation link that matches nothing this browser started.
    if (setupAction) {
      const foreign = routeContext(`?${query}&state=install_${'x'.repeat(43)}`, started.browser);
      expect((await call(CALLBACK, foreign)).headers.get('location')).toBe(`/app/settings/publishing?github=${returned}#github`);
    }
    // Nothing recorded or consumed: the installation started here can still return, and the card only checks again.
    expect(await getStore().getDoc(diagnosisPath)).toEqual(before);
    expect(await getStore().getDoc(grantPath)).toEqual(grant);
    // Match the injected installation id as a value, not as digits that a timestamp such as 09:52:55.999Z can contain.
    expect(JSON.stringify(await getStore().getDoc(diagnosisPath))).not.toMatch(/"(?:id|installation_id)":"?999"?[,}]/);
  });

  it('tells the page whether Check again can run and an installation started here is pending', async () => {
    const state = async () => (await (await call(STATUS, routeContext())).json()).github_attempt;
    expect(await state()).toEqual({ recheck_available: false, installation_started_at: null });
    await attempt(installations());
    expect(await state()).toEqual({ recheck_available: true, installation_started_at: null });
    const before = Date.now();
    const started = await startGithubInstallation(session);
    const pending = await state();
    expect(Date.parse(pending.installation_started_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(JSON.stringify(pending)).not.toMatch(/install_|synthetic-owner|78/);
    // Another admin sees neither this person's identity nor their installation.
    expect(await (await import('../../lib/publishing/github-connection')).githubReturnState({ orgId: 'default', userId: 'other-admin' }))
      .toEqual({ recheck_available: false, installation_started_at: null });
    await getStore().updateDoc(diagnosisPath, { identity_verified_at: Date.now() - 61 * 60 * 1000 });
    expect((await state()).recheck_available).toBe(false);
    // GitHub returned to the Setup URL: the installation is no longer pending.
    await call(CALLBACK, routeContext(`?state=${new URL(started.url).searchParams.get('state')}&setup_action=install&installation_id=36`, started.browser));
    expect((await state()).installation_started_at).toBeNull();
  });

  it('can open the installation page from any diagnosis, without a previous sign-in', async () => {
    const started = await startGithubInstallation(session);
    expect(new URL(started.url).origin + new URL(started.url).pathname).toBe('https://github.com/apps/synthetic-publisher/installations/new');
    // GitHub passes this state back to the Setup URL only because the link carries it.
    expect(new URL(started.url).searchParams.get('state')).toMatch(/^install_[\w-]{43}$/);
  });

  it('keeps connecting organizations when the App does not use expiring user tokens', async () => {
    const { result } = await attempt({ ...installations(personal, owned), '/login/oauth/access_token': { access_token: 'synthetic-user-token' } });
    expect(result).toBe('connected');
    expect((await getConnection('default', 'github')).github?.owner).toBe('owned-org');
    expect(blockers(await stored(), '36')).toEqual(['expiring_tokens_disabled']);
    expect((await stored()).installations.find(item => item.installation_id === '36')!.blockers[0].who).toBe('publisher');
  });

  it.each([
    ['incorrect_client_credentials', 'publisher_app_misconfigured', 'unavailable'],
    ['bad_verification_code', 'state_expired', 'sign_in_required'],
  ])('maps the token exchange error %s', async (oauthError, code, outcome) => {
    const { error } = await attempt({ '/login/oauth/access_token': { error: oauthError, error_description: 'synthetic-provider-text' } });
    expect(error?.code).toBe(code);
    expect(await stored()).toMatchObject({ outcome, blockers: [expect.objectContaining({ code })] });
    expect(JSON.stringify(await stored())).not.toContain('synthetic-provider-text');
  });

  it('separates missing encryption from a missing App and shows the configured App', async () => {
    vi.stubEnv('INTEGRATIONS_SECRET_KEY', '');
    expect(githubSetup()).toMatchObject({ available: false, app_configured: true, encryption_available: false, app_slug: 'synthetic-publisher' });
    const diagnosis = await currentGithubDiagnosis('default', session);
    expect(diagnosis).toMatchObject({ outcome: 'unavailable', blockers: [expect.objectContaining({ code: 'encryption_unavailable', who: 'publisher' })] });
    expect(diagnosis.blockers[0].message).toContain('synthetic-publisher');
    vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
    vi.stubEnv('TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY', '');
    expect(githubSetup()).toMatchObject({ available: false, app_configured: false, encryption_available: true });
    expect((await currentGithubDiagnosis('default', session)).blockers[0].code).toBe('publisher_app_misconfigured');
  });

  it('records a revision conflict when the connection changes during sign-in', async () => {
    const started = await startGithubConnection(session);
    await disconnect('default', 'github', (await getConnection('default', 'github')).revision);
    await expect(finishGithubConnection(session, { browser: started.browser, state: new URL(started.url).searchParams.get('state')!, code: 'c' }, providerFetch()))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    // The diagnosis describes the revision of the attempt, which is no longer current.
    expect((await getStore().getDoc<any>(diagnosisPath)).blockers[0].code).toBe('revision_conflict');
  });

  it('binds the stored diagnosis to the person and the connection revision', async () => {
    await attempt(installations(memberOnly));
    expect((await currentGithubDiagnosis('default', { userId: 'other-admin' })).outcome).toBe('sign_in_required');
    expect((await currentGithubDiagnosis('default')).outcome).toBe('action_required');
    await disconnect('default', 'github', (await getConnection('default', 'github')).revision);
    expect((await stored()).outcome).toBe('sign_in_required');
  });

  it('records an OAuth error only for the sign-in that this person started in this browser', async () => {
    await attempt(installations(memberOnly));
    const before = await getStore().getDoc<any>(diagnosisPath);
    const started = await startGithubConnection(session);
    const state = new URL(started.url).searchParams.get('state')!;
    // A link from another site carries no matching state or browser cookie: nothing is recorded or consumed.
    for (const [search, cookie] of [['?error=access_denied', undefined], [`?error=access_denied&state=${state}`, undefined],
      [`?error=access_denied&state=${state}`, 'y'.repeat(43)], ['?error=access_denied&state=' + 'x'.repeat(43), started.browser],
      ['?code=synthetic-code&state=' + 'x'.repeat(43), started.browser], ['?code=synthetic-code&state=forged', started.browser]] as const) {
      const response = await call(CALLBACK, routeContext(search, cookie));
      expect(response.headers.get('location'), search).toBe('/app/settings/publishing?github=state_expired#github');
    }
    expect(await getStore().getDoc(diagnosisPath)).toEqual(before);
    const cancelled = await call(CALLBACK, routeContext(`?error=access_denied&state=${state}`, started.browser));
    expect(cancelled.headers.get('location')).toBe('/app/settings/publishing?github=sign_in_required#github');
    const raw = await getStore().getDoc<any>(diagnosisPath);
    expect(raw).toMatchObject({ blockers: [expect.objectContaining({ code: 'oauth_cancelled' })], verified_user: { id: '78', login: 'synthetic-owner' },
      identity_verified_at: before.identity_verified_at });
    // Single use: the same return cannot be recorded twice.
    expect((await call(CALLBACK, routeContext(`?error=access_denied&state=${state}`, started.browser))).headers.get('location')).toBe('/app/settings/publishing?github=state_expired#github');
  });

  it('keeps the proven GitHub identity when a later result of the same person proves none', async () => {
    await attempt(installations());
    const proven = (await getStore().getDoc<any>(diagnosisPath)).identity_verified_at;
    const started = await startGithubInstallation(session);
    await call(CALLBACK, routeContext(`?state=${new URL(started.url).searchParams.get('state')}&setup_action=request`, started.browser));
    expect(await getStore().getDoc<any>(diagnosisPath)).toMatchObject({ outcome: 'waiting_on_owner', github_user: null,
      verified_user: { id: '78', login: 'synthetic-owner' }, identity_verified_at: proven });
    // Waiting for an owner offers Check again while the identity is trusted, and a sign-in after that.
    expect((await stored()).primary_action).toEqual({ kind: 'retry', label: 'Check again' });
    await getStore().updateDoc(diagnosisPath, { identity_verified_at: Date.now() - 61 * 60 * 1000 });
    expect((await stored()).primary_action).toEqual({ kind: 'sign_in', label: 'Sign in to GitHub to check again' });
  });

  it('replaces an expired account choice with an action that still works', async () => {
    const second = { ...owned, id: 37, account: { id: 58, login: 'second-org', type: 'Organization' } };
    expect((await attempt({ ...installations(owned, second), '/orgs/second-org/memberships/synthetic-owner': admin(58) })).result).toBe('select');
    expect((await stored()).outcome).toBe('choose');
    await getStore().updateDoc(diagnosisPath, { selection_expires_at: Date.now() - 1 });
    await getStore().updateDoc('organizations/default/publishing_authorizations/github_selection', { expires_at: Date.now() - 1 });
    const expired = await stored();
    expect(expired).toMatchObject({ outcome: 'sign_in_required', primary_action: { kind: 'retry', label: 'Check again' },
      blockers: [expect.objectContaining({ code: 'state_expired', message: expect.stringContaining('choice expired') })] });
    expect(await githubChoices(session)).toEqual([]);
    await getStore().updateDoc(diagnosisPath, { identity_verified_at: Date.now() - 61 * 60 * 1000 });
    expect((await stored()).primary_action).toEqual({ kind: 'sign_in', label: 'Sign in to GitHub again' });
  });

  it('never marks a working connection as needing attention because of one person’s sign-in', async () => {
    expect((await attempt()).result).toBe('connected');
    const started = await startGithubConnection(session);
    await call(CALLBACK, routeContext(`?error=access_denied&state=${new URL(started.url).searchParams.get('state')}`, started.browser));
    // The person sees why their own sign-in stopped, with a way to try again.
    expect(await stored()).toMatchObject({ outcome: 'connected', primary_action: { kind: 'sign_in' }, blockers: [expect.objectContaining({ code: 'oauth_cancelled' })] });
    for (const view of [await currentGithubDiagnosis('default', { userId: 'other-admin' }), await currentGithubDiagnosis('default')]) {
      expect(view).toMatchObject({ outcome: 'connected', blockers: [], github_user: null, attempted_by: null,
        installations: [expect.objectContaining({ installation_id: '34', usable: true })] });
    }
    // Neither does a different account that cannot replace the connected one.
    const second = { ...owned, id: 35, account: { id: 57, login: 'second-org', type: 'Organization' } };
    await attempt({ ...installations(second), '/orgs/second-org/memberships/synthetic-owner': admin(57) });
    expect(blockers(await stored(), '35')).toEqual(['locked_to_account']);
    expect((await stored()).outcome).toBe('connected');
    expect((await currentGithubDiagnosis('default', { userId: 'other-admin' })).installations.map(item => item.installation_id)).toEqual(['34']);
  });

  it('shows API keys only the organization’s state, never the person’s attempt', async () => {
    const sso = new Response('{}', { status: 403, headers: { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/owned-org/sso?authorization_request=synthetic' } });
    await attempt({ '/user/installations?per_page=100&page=1': sso });
    expect(JSON.stringify(await stored())).toContain('authorization_request');
    await attempt(installations(memberOnly));
    const view = await currentGithubDiagnosis('default');
    expect(view).toMatchObject({ outcome: 'action_required', github_user: null, attempted_by: null, installations: [],
      blockers: [expect.objectContaining({ code: 'no_installation' })], primary_action: { kind: 'install' } });
    expect(JSON.stringify(view)).not.toMatch(/synthetic-owner|member-org|dev-user/);
    await attempt({ '/user/installations?per_page=100&page=1': new Response('{}', { status: 403, headers: { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/owned-org/sso?authorization_request=synthetic' } }) });
    expect(JSON.stringify(await currentGithubDiagnosis('default'))).not.toContain('authorization_request');
  });

  it('does not replace another admin’s GitHub sign-in that is still in progress', async () => {
    const grantPath = 'organizations/default/publishing_authorizations/github';
    await startGithubConnection({ ...session, userId: 'other-admin' });
    await expect(startGithubInstallation(session)).rejects.toMatchObject({ status: 409, code: 'github_sign_in_in_progress' });
    expect(await getStore().getDoc(grantPath)).toMatchObject({ user_id: 'other-admin' });
    await getStore().updateDoc(grantPath, { expires_at: Date.now() - 1 });
    await expect(startGithubInstallation(session)).resolves.toMatchObject({ url: expect.stringContaining('/installations/new') });
    // The person's own pending sign-in can be replaced.
    await expect(startGithubInstallation(session)).resolves.toMatchObject({ url: expect.stringContaining('/installations/new') });
  });

  it('saves a renewed personal authorization when the connection changed during sign-in', async () => {
    expect((await attempt(installations(personal))).result).toBe('connected');
    const started = await startGithubConnection(session);
    await saveConnection('default', 'github', (await getConnection('default', 'github')).revision, { github_authorization_required: true });
    const renewed = providerFetch({ ...installations(personal), '/login/oauth/access_token': { ...expiring, access_token: 'synthetic-renewed-token' } });
    expect(await finishGithubConnection(session, { browser: started.browser, state: new URL(started.url).searchParams.get('state')!, code: 'c' }, renewed)).toBe('connected');
    const connection = await getConnection('default', 'github');
    expect(connection.github_authorization_required).toBe(false);
    expect(openCredentials<{ access_token: string }>('default', 'github', connection.encrypted_credentials!).access_token).toBe('synthetic-renewed-token');
  });

  it('allows a different account after disconnect only with a confirmation naming the previous account', async () => {
    expect((await attempt()).result).toBe('connected');
    const second = { ...owned, id: 35, account: { id: 57, login: 'second-org', type: 'Organization' } };
    const secondProvider = { ...installations(second), '/orgs/second-org/memberships/synthetic-owner': admin(57), '/app/installations/35': second, '/orgs/second-org': { id: 57 } };
    // While connected, another account is refused without an offer to replace it.
    await attempt(secondProvider);
    const refused = (await stored()).installations.find(item => item.installation_id === '35')!.blockers[0];
    expect(refused).toMatchObject({ code: 'locked_to_account', previous_account: { login: 'owned-org', id: '56' } });
    expect(refused.action).toBeUndefined();
    await disconnect('default', 'github', (await getConnection('default', 'github')).revision);
    expect((await attempt(secondProvider)).result).toBe('select');
    const diagnosis = await stored();
    expect(diagnosis.outcome).toBe('action_required');
    expect(diagnosis.primary_action).toEqual({ kind: 'confirm_account_change', label: 'Use second-org instead of owned-org', installation_id: '35' });
    expect(diagnosis.installations[0].blockers[0].previous_account).toEqual({ login: 'owned-org', id: '56', type: 'Organization' });
    expect(diagnosis.installations[0].blockers[0].message).toContain('not moved');
    expect(await githubChoices(session)).toEqual([expect.objectContaining({ installation_id: '35', account_change: { from_account_id: '56', from_owner: 'owned-org' } })]);
    const fetcher = providerFetch(secondProvider);
    await expect(selectGithubOrganization(session, '35', fetcher)).rejects.toMatchObject({ code: 'account_change_confirmation_required' });
    await expect(selectGithubOrganization(session, '35', fetcher, { confirmAccountChange: '57' })).rejects.toMatchObject({ code: 'account_change_confirmation_required' });
    expect(await githubChoices(session)).toHaveLength(1);
    await selectGithubOrganization(session, '35', fetcher, { confirmAccountChange: '56' });
    expect((await getConnection('default', 'github'))).toMatchObject({ status: 'connected', github: { owner: 'second-org', account_id: '57' } });
    expect((await stored()).outcome).toBe('connected');
    // Cross-tenant protection is unchanged: both claims stay with this organization.
    await expect(claimAccount('another-org', 'github', '57')).rejects.toThrow('another Typeroll organization');
  });

  it('treats saving the installation that is already connected as success, not a conflict', async () => {
    // A choice made at the revision before another tab connected the same installation.
    const revision = (await getConnection('default', 'github')).revision;
    const other = await startGithubConnection(session);
    expect(await finishGithubConnection(session, { browser: other.browser, state: new URL(other.url).searchParams.get('state')!, code: 'c' }, providerFetch())).toBe('connected');
    const before = await getConnection('default', 'github');
    expect(before.revision).not.toBe(revision);
    await getStore().setDoc('organizations/default/publishing_authorizations/github_selection', {
      user_id: session.userId, github_user: { id: 78, login: 'synthetic-owner' }, revision, identity_verified_at: Date.now(), expires_at: Date.now() + 60_000, consumed: false,
      choices: [{ owner: 'owned-org', installation_id: '34', account_id: '56', account_type: 'Organization' }] });
    await expect(selectGithubOrganization(session, '34', providerFetch())).resolves.toBeUndefined();
    expect(await getConnection('default', 'github')).toEqual(before);
    expect((await stored()).outcome).toBe('connected');
  });

  it('documents every blocker code at the anchor its help link uses', () => {
    const guide = readFileSync(new URL('../../../../docs-site/src/content/docs/guides/github-troubleshooting.mdx', import.meta.url), 'utf8');
    for (const code of GITHUB_BLOCKER_CODES) expect(guide, code).toContain(`### \`${code}\``);
    expect(githubBlocker('publisher_app_misconfigured').action?.url).toBe('https://typeroll.com/docs/guides/github-troubleshooting/#publisher_app_misconfigured');
  });

  it('writes reasons as sentences that keep account names as GitHub spells them', () => {
    const organization = { login: 'Moveria-AB', type: 'Organization' as const, id: '57' };
    expect(githubBlocker('not_org_owner', { account: organization, user: { login: 'bootingbots' } }).message)
      .toMatch(/^@bootingbots is not an owner of Moveria-AB\. Only an organization owner can connect it to Typeroll\./);
    expect(githubBlocker('repository_selection_limited', { account: organization, installationId: '35' }).message)
      .toContain('so an owner of Moveria-AB must change repository access');
    expect(githubBlocker('permissions_missing', { account: organization, notRequested: true }).message).toContain('Then an owner of Moveria-AB must accept the update.');
    expect(githubBlocker('repository_selection_limited', { account: { ...organization, type: 'User', login: 'BootingBots' }, installationId: '36' }).message)
      .toContain('so only @BootingBots can change');
    for (const code of GITHUB_BLOCKER_CODES) {
      // No message starts with a name of who acts; the card shows that as its own label.
      const message = githubBlocker(code, { account: organization, installationId: '35', user: { login: 'bootingbots' } }).message;
      expect(message, code).not.toMatch(/^(You|GitHub organization owner|Typeroll publisher|Typeroll administrator) [a-z@]/);
    }
  });

  it('gives every blocker an owner, a message and, for the person, an action', () => {
    for (const code of GITHUB_BLOCKER_CODES) {
      const blocker = githubBlocker(code, { account: { login: 'owned-org', type: 'Organization', id: '56' }, installationId: '34', previous: { login: 'old', id: '1', type: 'Organization', connected: false } });
      expect(blocker.message.length, code).toBeGreaterThan(20);
      expect(['you', 'github_owner', 'publisher', 'typeroll_admin']).toContain(blocker.who);
      expect(blocker.action, code).toBeDefined();
      if (blocker.action?.url) expect(blocker.action.url, code).toMatch(/^https:\/\/(github\.com|typeroll\.com)\//);
    }
  });
});

describe('Check again without a new sign-in', () => {
  const missing = () => new Response('{}', { status: 404 });
  const appView = (overrides: Record<string, unknown> = {}) => providerFetch({
    '/users/synthetic-owner/installation': missing(), '/orgs/member-org/installation': memberOnly, '/orgs/owned-org/installation': owned,
    '/orgs/member-org/memberships/synthetic-owner': admin(57), ...overrides });

  it('re-checks roles with App authority and offers a now-owned organization for explicit confirmation', async () => {
    await attempt(installations(memberOnly));
    const grant = await getStore().getDoc('organizations/default/publishing_authorizations/github');
    const fetcher = appView();
    const diagnosis = await recheckGithubDiagnosis(session, { person: true }, fetcher);
    expect(diagnosis).toMatchObject({ outcome: 'choose', github_user: { login: 'synthetic-owner' }, installations: [expect.objectContaining({ installation_id: '35', usable: true, blockers: [] })] });
    // Nothing is connected or consumed by a re-check; the person still confirms the account.
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
    expect(await getStore().getDoc('organizations/default/publishing_authorizations/github')).toEqual(grant);
    expect(await githubChoices(session)).toEqual([expect.objectContaining({ installation_id: '35', owner: 'member-org' })]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).not.toContain('/login/oauth');
      expect((init?.headers as Record<string, string>).Authorization).not.toContain('synthetic-user-token');
    }
    await selectGithubOrganization(session, '35', fetcher);
    expect((await getConnection('default', 'github')).github?.owner).toBe('member-org');
  });

  it('still reports the role when the person is not an owner yet', async () => {
    await attempt(installations(memberOnly));
    const diagnosis = await recheckGithubDiagnosis(session, { person: true }, appView({ '/orgs/member-org/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 57 } } }));
    expect(diagnosis.outcome).toBe('action_required');
    expect(blockers(diagnosis, '35')).toEqual(['not_org_owner']);
    expect(await githubChoices(session)).toEqual([]);
  });

  it('finds an installation on an organization the person names', async () => {
    await attempt(installations(memberOnly));
    const diagnosis = await recheckGithubDiagnosis(session, { person: true, owner: 'owned-org' }, appView({ '/orgs/owned-org/memberships/synthetic-owner': admin(56),
      '/orgs/member-org/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 57 } } }));
    expect(diagnosis.outcome).toBe('choose');
    expect(diagnosis.installations.find(item => item.installation_id === '34')?.usable).toBe(true);
    await expect(recheckGithubDiagnosis({ ...session, orgId: 'default' }, { person: true, owner: 'not a login' })).rejects.toThrow('address name');
  });

  it('does not reveal anything about a named organization the person does not own', async () => {
    await claimAccount('another-org', 'github', '90');
    await attempt(installations(memberOnly));
    const foreign = { ...owned, id: 40, account: { id: 90, login: 'foreign-org', type: 'Organization' }, repository_selection: 'selected', suspended_at: '2026-09-01', permissions: { members: 'read' } };
    const check = async (overrides: Record<string, unknown>) => {
      // Each check runs after the five-second throttle.
      await getStore().updateDoc(diagnosisPath, { rechecked_at: Date.now() - 60_000 });
      return recheckGithubDiagnosis(session, { person: true, owner: 'foreign-org' }, appView({ '/app/installations/40/access_tokens': { token: 'synthetic-installation-token' },
        '/orgs/member-org/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 57 } }, ...overrides }));
    };
    const answers = [
      await check({ '/orgs/foreign-org/installation': foreign, '/orgs/foreign-org/memberships/synthetic-owner': missing() }),
      // A second check does not reveal it either: the hidden account is never stored as one to re-check.
      await check({ '/orgs/foreign-org/installation': foreign, '/orgs/foreign-org/memberships/synthetic-owner': missing() }),
      await check({ '/orgs/foreign-org/installation': { ...foreign, permissions: {} } }),
      await check({ '/orgs/foreign-org/installation': missing() }),
    ];
    for (const diagnosis of answers) {
      expect(diagnosis.installations.map(item => item.installation_id)).toEqual(['35']);
      expect(diagnosis.blockers.map(item => item.code)).toEqual(['not_org_owner', 'no_installation']);
      expect(diagnosis.blockers[0]).toEqual(answers[0].blockers[0]);
      expect(JSON.stringify(diagnosis)).not.toMatch(/installation_suspended|repository_selection_limited|permissions|claimed_by_other_organization|"40"/);
    }
    expect(answers[0].blockers[0].message).toContain('Either the App is not installed on foreign-org or you are not an owner of it');
    expect((await getStore().getDoc<any>(diagnosisPath)).accounts).toEqual([{ login: 'member-org', type: 'Organization', origin: 'oauth' }]);
  });

  it('explains installation settings only to a proven owner of the account', async () => {
    await claimAccount('another-org', 'github', '57');
    await attempt(installations({ ...memberOnly, suspended_at: '2026-09-01', repository_selection: 'selected' }));
    expect(blockers(await stored(), '35')).toEqual(['not_org_owner']);
    // Once the person proves they own a named organization, it is explained and re-checked like the others.
    await getStore().updateDoc(diagnosisPath, { rechecked_at: null });
    const diagnosis = await recheckGithubDiagnosis(session, { person: true, owner: 'owned-org' }, appView({ '/orgs/owned-org/memberships/synthetic-owner': admin(56),
      '/orgs/member-org/installation': { ...memberOnly, suspended_at: '2026-09-01' }, '/orgs/member-org/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 57 } } }));
    expect(blockers(diagnosis, '35')).toEqual(['not_org_owner']);
    expect(blockers(diagnosis, '34')).toEqual([]);
    expect((await getStore().getDoc<any>(diagnosisPath)).accounts).toContainEqual({ login: 'owned-org', type: 'Organization', origin: 'owned' });
  });

  it('asks for a sign-in when the proven identity is older than an hour or belongs to someone else', async () => {
    await attempt(installations(memberOnly));
    const fetcher = appView();
    expect((await recheckGithubDiagnosis({ ...session, userId: 'other-admin' }, { person: true }, fetcher)).primary_action).toMatchObject({ kind: 'sign_in' });
    // An API key cannot act as the person; it receives the organization's state.
    expect(await recheckGithubDiagnosis({ ...session, userId: 'api-key:abc' }, { person: false }, fetcher))
      .toMatchObject({ outcome: 'action_required', github_user: null, attempted_by: null, installations: [] });
    await getStore().updateDoc(diagnosisPath, { identity_verified_at: Date.now() - 61 * 60 * 1000 });
    const expired = await recheckGithubDiagnosis(session, { person: true }, fetcher);
    expect(expired.primary_action).toEqual({ kind: 'sign_in', label: 'Sign in to GitHub to check again' });
    expect(blockers(expired, '35')).toEqual(['not_org_owner']);
    expect(fetcher).not.toHaveBeenCalled();
    // The sign-in is what the card shows after reloading, too.
    expect((await stored()).primary_action).toEqual({ kind: 'sign_in', label: 'Sign in to GitHub to check again' });
  });

  it('checks again after an owner approves an installation request, within the hour of the sign-in', async () => {
    await attempt(installations());
    const started = await startGithubInstallation(session);
    await call(CALLBACK, routeContext(`?state=${new URL(started.url).searchParams.get('state')}&setup_action=request`, started.browser));
    expect((await stored()).outcome).toBe('waiting_on_owner');
    // The owner approved: GitHub now shows the installation to the App, and the person is an owner.
    const diagnosis = await recheckGithubDiagnosis(session, { person: true, owner: 'member-org' }, appView());
    expect(diagnosis).toMatchObject({ outcome: 'choose', installations: [expect.objectContaining({ installation_id: '35', usable: true })] });
    expect(await stored()).toMatchObject({ outcome: 'choose' });
  });

  it('stores a re-check after the 24-hour diagnosis expiry and never reports a failed store as connected', async () => {
    expect((await attempt()).result).toBe('connected');
    await getStore().updateDoc(diagnosisPath, { expires_at: Date.now() - 1, sequence: 7 });
    const suspended = providerFetch({ '/app/installations/34': { ...owned, suspended_at: '2026-09-30' } });
    expect((await recheckGithubDiagnosis({ ...session, userId: 'api-key:abc' }, { person: false }, suspended)).outcome).toBe('needs_attention');
    expect(await storedGithubDiagnosis('default')).toMatchObject({ outcome: 'needs_attention', sequence: 8 });
    // A concurrent result recorded first: this check's own result is still returned.
    await getStore().updateDoc(diagnosisPath, { rechecked_at: null });
    vi.spyOn(getStore(), 'compareAndUpdateDoc').mockResolvedValue(null);
    expect((await recheckGithubDiagnosis({ ...session, userId: 'api-key:abc' }, { person: false }, suspended)).outcome).toBe('needs_attention');
  });

  it('keeps a choice from Check again valid only within the hour of the sign-in', async () => {
    await attempt(installations(memberOnly));
    const verifiedAt = Date.now() - 59 * 60 * 1000;
    await getStore().updateDoc(diagnosisPath, { identity_verified_at: verifiedAt });
    expect((await recheckGithubDiagnosis(session, { person: true }, appView())).outcome).toBe('choose');
    const selectionPath = 'organizations/default/publishing_authorizations/github_selection';
    const selection = await getStore().getDoc<any>(selectionPath);
    expect(selection.expires_at).toBe(verifiedAt + 60 * 60 * 1000);
    expect((await getStore().getDoc<any>(diagnosisPath)).selection_expires_at).toBe(verifiedAt + 60 * 60 * 1000);
    // Ownership is re-verified at save only for an identity proven within the hour.
    await getStore().updateDoc(selectionPath, { identity_verified_at: Date.now() - 61 * 60 * 1000 });
    await expect(selectGithubOrganization(session, '35', appView())).rejects.toMatchObject({ code: 'state_expired' });
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
  });

  it('throttles repeated checks for five seconds per organization', async () => {
    await attempt(installations(memberOnly));
    const first = await recheckGithubDiagnosis(session, { person: true }, appView());
    const fetcher = appView();
    const second = await recheckGithubDiagnosis(session, { person: true }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it('names the one confirmation a ready personal account needs, not a sign-in', async () => {
    await attempt(installations(memberOnly));
    const diagnosis = await recheckGithubDiagnosis(session, { person: true }, appView({ '/users/synthetic-owner/installation': personal,
      '/orgs/member-org/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 57 } } }));
    expect(diagnosis.primary_action).toEqual({ kind: 'sign_in', label: 'Connect @synthetic-owner' });
    expect(diagnosis.installations.find(item => item.installation_id === '36')).toMatchObject({ usable: true, account: { type: 'User' } });
    expect(await githubChoices(session)).toEqual([]);
    expect((await stored()).primary_action).toEqual({ kind: 'sign_in', label: 'Connect @synthetic-owner' });
    // Sign-in wording only once no GitHub identity is trusted any more.
    await getStore().updateDoc(diagnosisPath, { identity_verified_at: Date.now() - 61 * 60 * 1000 });
    expect((await stored()).primary_action).toEqual({ kind: 'sign_in', label: 'Sign in to GitHub to connect @synthetic-owner' });
  });

  it('adds a publisher note when an installation started here never returned to the callback', async () => {
    await attempt(installations());
    const started = await startGithubInstallation(session);
    const grantPath = 'organizations/default/publishing_authorizations/github';
    const ready = appView({ '/users/synthetic-owner/installation': personal });
    // Within two minutes GitHub may still be returning: no note.
    expect((await recheckGithubDiagnosis(session, { person: true }, ready)).blockers.map(item => item.code)).toEqual([]);
    // Three minutes later, with the App installed on the person's own account and no callback, the Setup URL is probably missing.
    await getStore().updateDoc(grantPath, { expires_at: Date.now() + 7 * 60 * 1000 });
    await getStore().updateDoc(diagnosisPath, { rechecked_at: null });
    const diagnosis = await recheckGithubDiagnosis(session, { person: true }, ready);
    expect(diagnosis).toMatchObject({ outcome: 'action_required', primary_action: { kind: 'sign_in', label: 'Connect @synthetic-owner' } });
    expect(diagnosis.blockers).toEqual([expect.objectContaining({ code: 'setup_url_missing', who: 'publisher',
      action: { kind: 'contact_publisher', label: 'What the publisher must change', url: 'https://typeroll.com/docs/guides/github-troubleshooting/#setup_url_missing' } })]);
    expect(diagnosis.blockers[0].message).toContain('Setup URL (http://localhost/api/orgs/publishing/github/callback, with “Redirect on update”)');
    // Other admins and API keys see the publisher note too.
    expect((await currentGithubDiagnosis('default')).blockers.map(item => item.code)).toEqual(['setup_url_missing']);
    // Nothing installed on an account the person owns: no note, only the installation step.
    await getStore().updateDoc(diagnosisPath, { rechecked_at: null });
    expect((await recheckGithubDiagnosis(session, { person: true }, appView())).blockers.map(item => item.code)).toEqual(['no_installation']);
    // A return to the callback consumes the installation; afterwards there is nothing to report.
    await call(CALLBACK, routeContext(`?state=${new URL(started.url).searchParams.get('state')}&setup_action=install&installation_id=36`, started.browser));
    await getStore().updateDoc(diagnosisPath, { rechecked_at: null });
    expect((await recheckGithubDiagnosis(session, { person: true }, ready)).blockers).toEqual([]);
  });

  it('re-checks a saved connection with App authority, also for API keys', async () => {
    expect((await attempt()).result).toBe('connected');
    const suspended = await recheckGithubDiagnosis({ ...session, userId: 'api-key:abc' }, { person: false }, providerFetch({ '/app/installations/34': { ...owned, suspended_at: '2026-09-30' } }));
    expect(suspended).toMatchObject({ outcome: 'needs_attention', installations: [expect.objectContaining({ usable: false, blockers: [expect.objectContaining({ code: 'installation_suspended' })] })] });
    // The state of a saved connection is shared with every publishing admin.
    expect((await currentGithubDiagnosis('default', { userId: 'other-admin' })).outcome).toBe('needs_attention');
  });

  it('serves the portal re-check only to same-origin publishing admins', async () => {
    await attempt(installations(memberOnly));
    vi.stubGlobal('fetch', appView());
    const request = (origin: string, body: unknown) => {
      const context = routeContext();
      context.request = new Request('http://localhost/api/orgs/publishing/github/diagnosis', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
      return context;
    };
    expect((await call(RECHECK, request('https://elsewhere.test', { action: 'recheck' }))).status).toBe(403);
    expect((await call(RECHECK, request('http://localhost', { action: 'other' }))).status).toBe(400);
    const response = await call(RECHECK, request('http://localhost', { action: 'recheck' }));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).diagnosis.outcome).toBe('choose');
    expect((await (await call(DIAGNOSIS, routeContext())).json()).diagnosis.outcome).toBe('choose');
    await getStore().updateDoc('organizations/default/members/dev-user', { role: 'editor' });
    expect((await call(RECHECK, request('http://localhost', { action: 'recheck' }))).status).toBe(403);
  });
});
