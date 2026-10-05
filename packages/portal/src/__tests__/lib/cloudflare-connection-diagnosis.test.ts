// Every way the Cloudflare connection can stop must leave a persisted diagnosis,
// per organization and Hosting Group, that names who must act and offers one
// action for the fix. Nothing secret is ever stored in it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, disconnect, getConnection, openCredentials, saveConnection, sealCredentials } from '../../lib/publishing/connections';
import {
  cloudflareChoices, CLOUDFLARE_SCOPES, finishCloudflareConnection, recheckCloudflareDiagnosis, selectCloudflareAccount, startCloudflareConnection,
  type CloudflareStoredCredentials,
} from '../../lib/publishing/cloudflare-oauth';
import {
  CLOUDFLARE_BLOCKER_CODES, cloudflareBlocker, cloudflareOrganizationView, currentCloudflareDiagnosis, type CloudflareConnectionDiagnosis,
} from '../../lib/publishing/cloudflare-diagnosis';
import { saveHostingGroup } from '../../lib/publishing/hosting-groups';
import { GET as CALLBACK } from '../../pages/api/orgs/publishing/cloudflare/callback';
import { GET as DIAGNOSIS, POST as RECHECK } from '../../pages/api/orgs/publishing/cloudflare/diagnosis';
import { GET as STATUS } from '../../pages/api/orgs/publishing/index';

const session = { userId: 'dev-user', email: 'dev@typeroll.local', orgId: 'default' };
const staging = { id: 'a'.repeat(32), name: 'Staging Account' };
const autopilot = { id: 'b'.repeat(32), name: 'Autopilot' };
const token = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer', scope: CLOUDFLARE_SCOPES.join(' ') };
const SECRETS = /synthetic-access|synthetic-refresh|synthetic-code|synthetic-secret|synthetic-provider-text|code_verifier/;

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-secret');
  await getStore().setDoc('organizations/default/members/dev-user', { role: 'owner' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

type Reply = Response | Record<string, unknown> | ((init?: RequestInit) => Response);
/** Synthetic Cloudflare: OAuth token endpoint and API v4, with per-path overrides. */
function cloudflare(options: { accounts?: Array<{ id: string; name: string }>; exchange?: Reply; pages?: Record<string, Reply>; listing?: Reply } = {}) {
  const accounts = options.accounts ?? [staging];
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe('error');
    const target = new URL(String(url));
    const reply = (value: Reply) => typeof value === 'function' ? value(init) : value instanceof Response ? value : Response.json(value);
    if (target.pathname === '/oauth2/token') return reply(options.exchange ?? token);
    if (target.pathname === '/client/v4/accounts') return reply(options.listing ?? { success: true, result: accounts });
    const pages = /^\/client\/v4\/accounts\/([a-f0-9]{32})\/pages\/projects$/.exec(target.pathname);
    if (pages) {
      // The access check sends no list options: an unsupported page size must not look like missing access.
      expect(target.search).toBe('');
      return reply(options.pages?.[pages[1]] ?? { success: true, result: [] });
    }
    const account = accounts.find(item => target.pathname === `/client/v4/accounts/${item.id}`);
    if (account) return Response.json({ success: true, result: account });
    throw new Error(`Unexpected provider request ${target.pathname}`);
  });
}
const denied = () => Response.json({ success: false, errors: [{ code: 10000, message: 'synthetic-provider-text' }] }, { status: 403 });

async function grant(groupId = 'default') {
  const started = await startCloudflareConnection(session, groupId);
  return { browser: started.browser, state: new URL(started.url).searchParams.get('state')!, code: 'synthetic-code', url: started.url };
}
async function attempt(fetcher: typeof fetch, groupId = 'default') {
  try { return { result: await finishCloudflareConnection(session, await grant(groupId), fetcher), error: null }; }
  catch (error) { return { result: null, error: error as Error & { code?: string; diagnosis?: CloudflareConnectionDiagnosis } }; }
}
const mine = (groupId = 'default') => currentCloudflareDiagnosis('default', groupId, session);
const codes = (diagnosis: CloudflareConnectionDiagnosis) => [...diagnosis.blockers, ...diagnosis.accounts.flatMap(item => item.blockers)].map(item => item.code);

function routeContext(search = '', cookie?: string, file = 'callback') {
  const url = new URL(`http://localhost/api/orgs/publishing/cloudflare/${file}${search}`);
  return { url, params: {}, cookies: { get: vi.fn((name: string) => name === 'typeroll_publishing_cloudflare' && cookie ? { value: cookie } : undefined), set: vi.fn(), delete: vi.fn() },
    request: new Request(url) };
}
const call = async (route: APIRoute, context: ReturnType<typeof routeContext>) => await route(context as unknown as Parameters<APIRoute>[0]) as Response;
function postContext(body: unknown) {
  const url = new URL('http://localhost/api/orgs/publishing/cloudflare/diagnosis');
  return { url, params: {}, cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    request: new Request(url, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}
/** Every stored document, to prove no secret reaches the diagnosis. */
function storedDiagnosisFiles(root = process.env.TYPEROLL_FIXTURES_DIR!): string {
  let text = '';
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    if (statSync(file).isDirectory()) text += storedDiagnosisFiles(file);
    else if (name.includes('cloudflare_diagnosis')) text += readFileSync(file, 'utf8');
  }
  return text;
}

describe('Cloudflare connection diagnosis', () => {
  it('gives every blocker code who acts, a message and one action', () => {
    for (const code of CLOUDFLARE_BLOCKER_CODES) {
      const blocker = cloudflareBlocker(code, { account: staging, previous: autopilot, permissions: ['page.write'] });
      expect(blocker.code).toBe(code);
      expect(['you', 'cloudflare_account_admin', 'publisher', 'typeroll_admin']).toContain(blocker.who);
      expect(blocker.message.length).toBeGreaterThan(20);
      expect(blocker.action, code).toBeDefined();
    }
  });

  it('records a started sign-in and explains one that never came back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await grant();
    expect(await mine()).toMatchObject({ outcome: 'sign_in_pending', primary_action: { kind: 'sign_in', label: 'Start Cloudflare sign-in again' } });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const later = await mine();
    expect(later).toMatchObject({ outcome: 'sign_in_required', blockers: [{ code: 'state_expired', who: 'you', action: { kind: 'sign_in', label: 'Connect Cloudflare again' } }] });
    expect(later.blockers[0].message).toContain('did not return to Typeroll within 10 minutes');
  });

  it('connects the only authorized account directly, through the callback route', async () => {
    const started = await grant();
    vi.stubGlobal('fetch', cloudflare());
    const response = await call(CALLBACK, routeContext(`?code=synthetic-code&state=${started.state}`, started.browser));
    expect(response.headers.get('location')).toBe('/app/settings/publishing?cloudflare=connected#cloudflare');
    expect((await getConnection('default', 'cloudflare')).cloudflare?.account_id).toBe(staging.id);
    expect(await mine()).toMatchObject({ outcome: 'connected', accounts: [{ id: staging.id, usable: true }], recheck_available: true });
    expect(storedDiagnosisFiles()).not.toMatch(SECRETS);
  });

  it('records a cancelled consent, a foreign browser and an expired sign-in from the callback', async () => {
    const cancelling = await grant();
    const cancelled = await call(CALLBACK, routeContext(`?error=access_denied&error_description=synthetic-provider-text&state=${cancelling.state}`, cancelling.browser));
    expect(cancelled.headers.get('location')).toBe('/app/settings/publishing?cloudflare=sign_in_required#cloudflare');
    expect(await mine()).toMatchObject({ outcome: 'sign_in_required', blockers: [{ code: 'oauth_cancelled', who: 'you', action: { kind: 'sign_in', label: 'Connect Cloudflare again' } }] });
    const started = await grant();
    await call(CALLBACK, routeContext(`?code=synthetic-code&state=${started.state}`, 'y'.repeat(43)));
    expect(codes(await mine())).toEqual(['wrong_browser']);
    await getStore().updateDoc('organizations/default/publishing_authorizations/cloudflare', { expires_at: Date.now() - 1 });
    await call(CALLBACK, routeContext(`?code=synthetic-code&state=${started.state}`, started.browser));
    expect(codes(await mine())).toEqual(['state_expired']);
    expect(storedDiagnosisFiles()).not.toMatch(SECRETS);
  });

  it('records nothing and consumes nothing for a forged callback', async () => {
    const started = await grant();
    const before = await getStore().getDoc('organizations/default/publishing_authorizations/cloudflare_diagnosis');
    const fetcher = cloudflare();
    vi.stubGlobal('fetch', fetcher);
    for (const [search, cookie] of [[`?code=synthetic-code&state=${'x'.repeat(43)}`, started.browser], ['?code=synthetic-code&state=forged', started.browser],
      [`?error=access_denied&state=${'x'.repeat(43)}`, started.browser], [`?error=access_denied&state=${started.state}`, undefined]] as const) {
      const response = await call(CALLBACK, routeContext(search, cookie));
      expect(response.headers.get('location')).toBe('/app/settings/publishing?cloudflare=state_expired#cloudflare');
    }
    // Another person's callback with this person's state is not theirs either.
    await getStore().setDoc('organizations/default/members/other-user', { role: 'owner' });
    await expect(finishCloudflareConnection({ ...session, userId: 'other-user' }, started, fetcher)).rejects.toMatchObject({ unrecorded: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getStore().getDoc('organizations/default/publishing_authorizations/cloudflare_diagnosis')).toEqual(before);
    expect(await getStore().getDoc('organizations/default/publishing_authorizations/cloudflare')).toMatchObject({ consumed: false });
    // The real return still works afterwards.
    expect(await finishCloudflareConnection(session, started, fetcher)).toBe('connected');
  });

  it('sends a callback without a Typeroll session to sign-in and back to the Cloudflare card', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const context = routeContext('?code=synthetic-code&state=x');
    const response = await call(CALLBACK, context);
    const location = new URL(response.headers.get('location')!, 'http://localhost');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/app/settings/publishing?cloudflare=session_expired#cloudflare');
    expect(response.headers.get('location')).not.toContain('synthetic-code');
    expect(context.cookies.delete).toHaveBeenCalled();
  });

  it('names the permissions the consent did not grant', async () => {
    const { error } = await attempt(cloudflare({ exchange: { ...token, scope: 'account-settings.read page.read offline_access' } }));
    expect(error).toMatchObject({ code: 'permissions_missing' });
    const diagnosis = await mine();
    expect(diagnosis).toMatchObject({ outcome: 'action_required', blockers: [{ code: 'permissions_missing', who: 'you',
      missing_permissions: ['page.write', 'workers-r2.read', 'workers-r2.write'], action: { kind: 'sign_in' } }] });
    expect(diagnosis.blockers[0].message).toContain('Cloudflare Pages: Edit, Workers R2 Storage: Read, Workers R2 Storage: Edit');
    expect((await getConnection('default', 'cloudflare')).status).toBe('disconnected');
  });

  it('accepts a token response without scope as the requested scopes (RFC 6749 section 5.1)', async () => {
    const { result } = await attempt(cloudflare({ exchange: { ...token, scope: undefined } }));
    expect(result).toBe('connected');
    const connection = await getConnection('default', 'cloudflare');
    expect(openCredentials<CloudflareStoredCredentials>('default', 'cloudflare', connection.encrypted_credentials!).oauth?.scope.split(' ')).toEqual(expect.arrayContaining(CLOUDFLARE_SCOPES));
  });

  it('retries the code exchange with client_secret_post when the client rejects HTTP Basic', async () => {
    const methods: string[] = [];
    const fetcher = cloudflare({ exchange: init => {
      const body = new URLSearchParams(String(init?.body));
      methods.push(new Headers(init?.headers).has('Authorization') ? 'basic' : body.get('client_secret') ? 'post' : 'none');
      return methods.length === 1 ? Response.json({ error: 'invalid_client' }, { status: 401 }) : Response.json(token);
    } });
    expect((await attempt(fetcher)).result).toBe('connected');
    expect(methods).toEqual(['basic', 'post']);
  });

  it.each([
    ['invalid_client', 401, 'publisher_oauth_misconfigured', 'unavailable'],
    ['invalid_grant', 400, 'state_expired', 'sign_in_required'],
    ['unsupported_grant_type', 400, 'publisher_oauth_misconfigured', 'unavailable'],
    ['', 429, 'rate_limited', 'retryable_error'],
    ['', 503, 'provider_unavailable', 'retryable_error'],
  ])('explains a token exchange error %s (HTTP %i)', async (error, status, code, outcome) => {
    const { error: thrown } = await attempt(cloudflare({ exchange: () => Response.json({ ...(error ? { error } : {}), error_description: 'synthetic-provider-text' }, { status }) }));
    expect(thrown).toMatchObject({ code });
    expect(await mine()).toMatchObject({ outcome, blockers: [expect.objectContaining({ code })] });
    expect(storedDiagnosisFiles()).not.toMatch(SECRETS);
  });

  it('explains a token without a refresh token as a publisher setting', async () => {
    await attempt(cloudflare({ exchange: { ...token, refresh_token: undefined } }));
    const diagnosis = await mine();
    expect(diagnosis).toMatchObject({ outcome: 'unavailable', blockers: [{ code: 'publisher_oauth_misconfigured', who: 'publisher', action: { kind: 'contact_publisher' } }] });
    expect(diagnosis.blockers[0].message).toContain('refresh_token grant');
  });

  it('explains a consent without any account', async () => {
    await attempt(cloudflare({ accounts: [] }));
    expect(await mine()).toMatchObject({ outcome: 'action_required', blockers: [{ code: 'no_eligible_account', who: 'you', action: { kind: 'sign_in' } }] });
  });

  it('explains more authorized accounts than Typeroll lists', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ id: index.toString(16).padStart(32, 'c'), name: `Account ${index}` }));
    await attempt(cloudflare({ accounts: many }));
    expect(codes(await mine())).toEqual(['too_many_accounts']);
    expect((await mine()).blockers[0].message).toContain('more than 1000');
  });

  it('keeps a saved connection on its original account', async () => {
    const current = await getConnection('default', 'cloudflare');
    await saveConnection('default', 'cloudflare', current.revision, { status: 'disconnected',
      cloudflare: { account_id: autopilot.id, account_name: autopilot.name, bucket: 'media', endpoint: '' } });
    await attempt(cloudflare({ accounts: [staging] }));
    const diagnosis = await mine();
    expect(diagnosis).toMatchObject({ outcome: 'action_required', blockers: [{ code: 'locked_to_account', who: 'you',
      previous_account: autopilot, account: staging, action: { kind: 'sign_in', label: 'Connect Autopilot again' } }] });
  });

  it('explains missing Pages access, and Check again finds the fixed role without a new sign-in or connecting by itself', async () => {
    const blocked = cloudflare({ pages: { [staging.id]: denied() } });
    const { error } = await attempt(blocked);
    expect(error).toMatchObject({ code: 'pages_access_denied' });
    const diagnosis = await mine();
    expect(diagnosis).toMatchObject({ outcome: 'action_required', blockers: [], recheck_available: true,
      accounts: [{ id: staging.id, usable: false, blockers: [{ code: 'pages_access_denied', who: 'cloudflare_account_admin',
        action: { kind: 'link', url: `https://dash.cloudflare.com/${staging.id}/members` } }] }] });
    expect(diagnosis.primary_action).toMatchObject({ kind: 'link' });
    expect(JSON.stringify(diagnosis)).not.toContain('synthetic-provider-text');
    // A Super Administrator changes the role; Check again reuses the consent from this hour.
    const checked = await recheckCloudflareDiagnosis(session, 'default', { person: true }, cloudflare());
    expect(checked).toMatchObject({ outcome: 'choose', accounts: [{ id: staging.id, usable: true }] });
    expect((await getConnection('default', 'cloudflare')).status).toBe('disconnected');
    expect(await cloudflareChoices(session)).toEqual([staging]);
    await selectCloudflareAccount(session, staging.id, cloudflare());
    expect(await mine()).toMatchObject({ outcome: 'connected' });
  });

  it('explains an account another Typeroll organization uses', async () => {
    await getStore().setDoc(`publishing_account_claims/cloudflare-${staging.id}`, { org_id: 'another' });
    await attempt(cloudflare());
    expect(await mine()).toMatchObject({ outcome: 'action_required',
      accounts: [{ id: staging.id, usable: false, blockers: [{ code: 'claimed_by_other_organization', who: 'typeroll_admin' }] }] });
  });

  it('offers a choice inside the card for two accounts, keeps it after an account-specific failure and connects the other one', async () => {
    const fetcher = cloudflare({ accounts: [staging, autopilot] });
    expect((await attempt(fetcher)).result).toBe('select');
    const choosing = await mine();
    expect(choosing).toMatchObject({ outcome: 'choose', primary_action: null, accounts: [{ id: staging.id, usable: true }, { id: autopilot.id, usable: true }] });
    expect(Date.parse(choosing.selection_expires_at!) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(await cloudflareChoices(session)).toEqual([staging, autopilot]);
    // Pages access to Staging was removed between the choice and the selection.
    await expect(selectCloudflareAccount(session, staging.id, cloudflare({ accounts: [staging, autopilot], pages: { [staging.id]: denied() } }))).rejects.toMatchObject({ code: 'pages_access_denied' });
    expect(await mine()).toMatchObject({ outcome: 'choose', accounts: [{ id: staging.id, usable: false, blockers: [{ code: 'pages_access_denied' }] }, { id: autopilot.id, usable: true }] });
    expect(await cloudflareChoices(session)).toEqual([autopilot]);
    await selectCloudflareAccount(session, autopilot.id, fetcher);
    expect((await getConnection('default', 'cloudflare')).cloudflare?.account_id).toBe(autopilot.id);
    expect(await mine()).toMatchObject({ outcome: 'connected' });
    expect(await getStore().getDoc('organizations/default/publishing_authorizations/cloudflare_selection')).toMatchObject({ encrypted_tokens: null });
    expect(storedDiagnosisFiles()).not.toMatch(SECRETS);
  });

  it('explains an expired choice, offers it again with Check again within the hour, then needs a new sign-in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetcher = cloudflare({ accounts: [staging, autopilot] });
    await attempt(fetcher);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const expired = await mine();
    expect(expired).toMatchObject({ outcome: 'action_required', recheck_available: true, primary_action: { kind: 'retry', label: 'Check again' },
      blockers: [{ code: 'account_choice_expired', who: 'you' }], accounts: [{ id: staging.id }, { id: autopilot.id }] });
    await expect(selectCloudflareAccount(session, staging.id, fetcher)).rejects.toMatchObject({ code: 'account_choice_expired' });
    expect(await cloudflareChoices(session)).toEqual([]);
    // Check again offers the same accounts for another 10 minutes, reusing (and renewing) the consent's tokens.
    vi.stubGlobal('fetch', fetcher);
    const response = await call(RECHECK, postContext({ action: 'recheck', hosting_group_id: 'default' }) as never);
    expect(response.status).toBe(200);
    expect((await response.json()).diagnosis).toMatchObject({ outcome: 'choose', recheck_available: true });
    expect(await cloudflareChoices(session)).toEqual([staging, autopilot]);
    // More than an hour after the consent only a new sign-in helps; nothing is silently dropped.
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect(await mine()).toMatchObject({ outcome: 'action_required', recheck_available: false, primary_action: { kind: 'sign_in', label: 'Connect Cloudflare again' },
      blockers: [{ code: 'account_choice_expired' }], accounts: [{ id: staging.id }, { id: autopilot.id }] });
    await recheckCloudflareDiagnosis(session, 'default', { person: true }, fetcher);
    expect(await getStore().getDoc('organizations/default/publishing_authorizations/cloudflare_selection')).toMatchObject({ encrypted_tokens: null });
  });

  it('explains a connection that changed during sign-in', async () => {
    const input = await grant();
    await disconnect('default', 'cloudflare', (await getConnection('default', 'cloudflare')).revision);
    await expect(finishCloudflareConnection(session, input, cloudflare())).rejects.toMatchObject({ code: 'revision_conflict' });
    // The stored attempt describes the old revision; the card shows the current state instead of a stale reason.
    expect((await mine()).outcome).toBe('sign_in_required');
  });

  it('keeps the consent after a passing Cloudflare failure so Check again needs no new sign-in', async () => {
    const { error } = await attempt(cloudflare({ listing: Response.json({ success: false }, { status: 502 }) }));
    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect(await mine()).toMatchObject({ outcome: 'retryable_error', recheck_available: true, primary_action: { kind: 'retry' } });
    const rateLimited = await attempt(cloudflare({ listing: Response.json({ success: false }, { status: 429 }) }));
    expect(rateLimited.error).toMatchObject({ code: 'rate_limited' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    const checked = await recheckCloudflareDiagnosis(session, 'default', { person: true }, cloudflare());
    // Check again never connects by itself: the one account is offered, preselected in the card.
    expect(checked).toMatchObject({ outcome: 'choose', accounts: [{ id: staging.id, usable: true }] });
  });

  it('re-verifies a saved connection: revoked authorization and Pages access', async () => {
    await attempt(cloudflare());
    const connection = await getConnection('default', 'cloudflare');
    const credentials = openCredentials<CloudflareStoredCredentials>('default', 'cloudflare', connection.encrypted_credentials!);
    credentials.oauth!.expires_at = 0;
    await getStore().updateDoc(connectionPath('default', 'cloudflare'), { encrypted_credentials: sealCredentials('default', 'cloudflare', credentials) });
    const revoked = await recheckCloudflareDiagnosis(session, 'default', { person: true }, cloudflare({ exchange: Response.json({ error: 'invalid_grant' }, { status: 400 }) }));
    expect(revoked).toMatchObject({ outcome: 'needs_attention', blockers: [{ code: 'authorization_revoked', who: 'you', action: { kind: 'sign_in', label: 'Reconnect Cloudflare' } }] });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    const pages = await recheckCloudflareDiagnosis({ orgId: 'default', userId: 'api-key:prefix' }, 'default', { person: false }, cloudflare({ pages: { [staging.id]: denied() } }));
    expect(pages).toMatchObject({ outcome: 'needs_attention', attempted_by: null, accounts: [{ id: staging.id, blockers: [{ code: 'pages_access_denied' }] }] });
    vi.setSystemTime(Date.now() + 10_000);
    expect(await recheckCloudflareDiagnosis(session, 'default', { person: true }, cloudflare())).toMatchObject({ outcome: 'connected', blockers: [] });
  });

  it('shows another admin and API keys the organization state, never a person’s accounts', async () => {
    await attempt(cloudflare({ pages: { [staging.id]: denied() } }));
    await getStore().setDoc('organizations/default/members/other-user', { role: 'owner' });
    expect(await currentCloudflareDiagnosis('default', 'default', { userId: 'other-user' })).toMatchObject({ outcome: 'sign_in_required', accounts: [] });
    const organization = await currentCloudflareDiagnosis('default', 'default');
    expect(organization).toMatchObject({ outcome: 'action_required', attempted_by: null, accounts: [], blockers: [{ code: 'pages_access_denied', who: 'cloudflare_account_admin' }] });
    expect(JSON.stringify(organization)).not.toMatch(/Staging Account|dev-user|a{32}/);
    expect(JSON.stringify(cloudflareOrganizationView(await mine()))).not.toMatch(/Staging Account|dev-user/);
  });

  it('keeps a separate diagnosis for each Hosting Group and returns to that group’s card', async () => {
    const group = await saveHostingGroup('default', { name: 'Hosting 2', sites_domain: null, dns_mode: 'external' });
    const started = await grant(group.id);
    vi.stubGlobal('fetch', cloudflare({ pages: { [staging.id]: denied() } }));
    const response = await call(CALLBACK, routeContext(`?code=synthetic-code&state=${started.state}`, started.browser));
    expect(response.headers.get('location')).toBe(`/app/settings/publishing?cloudflare=action_required&hosting_group=${group.id}#hosting-${group.id}`);
    expect(codes(await mine(group.id))).toEqual(['pages_access_denied']);
    expect((await mine('default')).outcome).toBe('sign_in_required');
    const read = await call(DIAGNOSIS, routeContext(`?hosting_group=${group.id}`, undefined, 'diagnosis'));
    expect((await read.json()).diagnosis).toMatchObject({ hosting_group_id: group.id, outcome: 'action_required' });
  });

  it('returns the diagnosis and the person’s choices with the Publishing status', async () => {
    await attempt(cloudflare({ accounts: [staging, autopilot] }));
    const body = await (await call(STATUS, routeContext('', undefined, '') as never)).json();
    expect(body.cloudflare_diagnosis).toMatchObject({ outcome: 'choose', hosting_group_id: 'default' });
    expect(body.cloudflare_choices).toEqual([staging, autopilot]);
    expect(JSON.stringify(body)).not.toMatch(SECRETS);
  });
});
