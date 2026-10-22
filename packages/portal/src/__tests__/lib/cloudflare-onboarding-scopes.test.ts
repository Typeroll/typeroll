// Optional Cloudflare permissions requested with Connect Cloudflare
// (TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES), the one permission update that
// adds them to existing connections, and how API/MCP report what is missing.
// Every OAuth and Cloudflare call is a synthetic double.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, getConnection, openCredentials, sealCredentials } from '../../lib/publishing/connections';
import {
  cloudflareUpdateContinuation, finishCloudflareConnection, startCloudflareConnection, startCloudflarePermissionUpdate, type CloudflareStoredCredentials,
} from '../../lib/publishing/cloudflare-oauth';
import { cloudflarePermissionReport, cloudflarePermissionReports } from '../../lib/publishing/cloudflare-capabilities';
import { saveHostingGroup } from '../../lib/publishing/hosting-groups';

const ORG = 'moveria';
const session = { userId: 'owner', email: 'owner@example.test', orgId: ORG } as never;
const ACCOUNT = { id: 'a'.repeat(32), name: 'Moveria AB' };
const OTHER = { id: 'b'.repeat(32), name: 'Other AB' };
const NEW_SCOPES = ['account-settings.write', 'account-analytics.read', 'dynamic-redirect.read', 'dynamic-redirect.write'];
const ENABLE_ALL = NEW_SCOPES.join(' ');
/** What Connect Cloudflare requested for Default before optional onboarding scopes existed. */
const TODAY_DEFAULT = ['account-settings.read', 'page.read', 'page.write', 'workers-r2.read', 'workers-r2.write', 'offline_access',
  'zone.read', 'cache.purge', 'dns.read', 'dns.write', 'zone-transform-rules.read', 'zone-transform-rules.write', 'workers-scripts.read', 'workers-scripts.write'];
const BASE = 'account-settings.read page.read page.write workers-r2.read workers-r2.write offline_access zone.read dns.read dns.write';

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-secret');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const requested = (url: string) => new URL(url).searchParams.get('scope')!.split(' ');

async function oauthConnection(groupId: string, scope: string, account = ACCOUNT, extra: Partial<CloudflareStoredCredentials> = {}) {
  await getStore().setDoc(connectionPath(ORG, 'cloudflare', groupId), {
    status: 'connected', revision: `rev-${groupId}`, auth_method: 'oauth', connected_at: '2026-10-01T00:00:00.000Z', media_ready: groupId === 'default',
    cloudflare: { account_id: account.id, account_name: account.name, bucket: groupId === 'default' ? 'originals' : '', public_bucket: groupId === 'default' ? 'public' : undefined, endpoint: '' },
    encrypted_credentials: sealCredentials(ORG, 'cloudflare', { oauth: { access_token: `old-${groupId}`, refresh_token: 'old-refresh', expires_at: Date.now() + 3_600_000, scope }, ...extra }, groupId),
  });
}

/** Synthetic Cloudflare: the token endpoint grants what was asked for; one account. */
function cloudflare(granted: () => string, accounts = [ACCOUNT]) {
  return vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/oauth2/token') return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer', scope: granted() });
    if (path === '/client/v4/accounts') return Response.json({ success: true, result: accounts });
    if (path.endsWith('/pages/projects')) return Response.json({ success: true, result: [] });
    const account = accounts.find(item => path === `/client/v4/accounts/${item.id}`);
    if (account) return Response.json({ success: true, result: account });
    throw new Error(`unexpected ${path}`);
  });
}

describe('scopes requested by Connect Cloudflare', () => {
  it('requests exactly what it did before when the deployment enables no optional scopes', async () => {
    expect(requested((await startCloudflareConnection(session)).url).sort()).toEqual([...TODAY_DEFAULT].sort());
    const group = await saveHostingGroup(ORG, { name: 'Second', dns_mode: 'automatic' });
    const second = requested((await startCloudflareConnection(session, group.id)).url);
    for (const scope of NEW_SCOPES) expect(second).not.toContain(scope);
    // The per-Site Analytics approval of older deployments still asks for the Analytics scopes.
    expect(requested((await startCloudflareConnection(session, 'default', false, true)).url)).toEqual(expect.arrayContaining(['account-settings.write', 'account-analytics.read']));
  });

  it('requests the enabled optional scopes for every Hosting Group and ignores unknown values', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', 'account-settings.write, account-analytics.read dynamic-redirect.read,dynamic-redirect.write zone.edit');
    expect(requested((await startCloudflareConnection(session)).url)).toEqual(expect.arrayContaining(NEW_SCOPES));
    const group = await saveHostingGroup(ORG, { name: 'Second', dns_mode: 'automatic' });
    const second = requested((await startCloudflareConnection(session, group.id)).url);
    expect(second).toEqual(expect.arrayContaining(NEW_SCOPES));
    expect(second).not.toContain('zone.edit');
    expect(second).not.toContain('workers-r2.read');
  });

  it('can enable redirect rules without Analytics', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', 'dynamic-redirect.read dynamic-redirect.write');
    const scopes = requested((await startCloudflareConnection(session)).url);
    expect(scopes).toEqual(expect.arrayContaining(['dynamic-redirect.read', 'dynamic-redirect.write']));
    expect(scopes).not.toContain('account-settings.write');
  });
});

describe('Approve update for an existing connection', () => {
  it('keeps every granted scope, the account and the R2 keys, and adds the enabled ones', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', ENABLE_ALL);
    const before = `${BASE} workers-ci.read workers-ci.write workers-scripts.read workers-scripts.write`;
    await oauthConnection('default', before, ACCOUNT, { access_key_id: 'synthetic-key', secret_access_key: 'synthetic-secret-key' });
    const started = await startCloudflarePermissionUpdate(session, 'default');
    const scopes = requested(started.url);
    expect(scopes).toEqual(expect.arrayContaining([...before.split(' '), ...NEW_SCOPES]));
    expect(started.hosting_group_ids).toEqual(['default']);

    const state = new URL(started.url).searchParams.get('state')!;
    expect(await finishCloudflareConnection(session, { state, browser: started.browser, code: 'synthetic-code' }, cloudflare(() => scopes.join(' ')))).toBe('connected');
    const connection = await getConnection(ORG, 'cloudflare');
    expect(connection).toMatchObject({ status: 'connected', media_ready: true, cloudflare: { account_id: ACCOUNT.id, bucket: 'originals' } });
    const credentials = openCredentials<CloudflareStoredCredentials>(ORG, 'cloudflare', connection.encrypted_credentials!);
    expect(credentials).toMatchObject({ access_key_id: 'synthetic-key', secret_access_key: 'synthetic-secret-key' });
    expect(credentials.oauth!.scope.split(' ')).toEqual(expect.arrayContaining([...before.split(' '), ...NEW_SCOPES]));
    expect((await cloudflarePermissionReport(ORG, 'default')).permission_update.required).toBe(false);
  });

  it('renews every connection of the Organization that uses the same account, one after another, and no other', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', ENABLE_ALL);
    const same = await saveHostingGroup(ORG, { name: 'Same account', dns_mode: 'automatic' });
    const other = await saveHostingGroup(ORG, { name: 'Other account', dns_mode: 'automatic' });
    await oauthConnection('default', BASE);
    await oauthConnection(same.id, BASE);
    await oauthConnection(other.id, BASE, OTHER);
    // Another Organization on the same Cloudflare account is never part of this Organization's update.
    await getStore().setDoc(connectionPath('another-org', 'cloudflare'), { status: 'connected', revision: 'r', auth_method: 'oauth', cloudflare: { account_id: ACCOUNT.id, account_name: ACCOUNT.name, bucket: '', endpoint: '' } });

    const report = await cloudflarePermissionReport(ORG, 'default');
    expect(report.permission_update).toMatchObject({ required: true, missing_scopes: NEW_SCOPES, hosting_group_ids: ['default', same.id] });
    expect(report.permission_update.next_step).toContain('same Cloudflare account');

    const started = await startCloudflarePermissionUpdate(session, 'default');
    expect(started.hosting_group_ids).toEqual(['default', same.id]);
    const state = new URL(started.url).searchParams.get('state')!;
    await finishCloudflareConnection(session, { state, browser: started.browser, code: 'synthetic-code' }, cloudflare(() => requested(started.url).join(' ')));
    const next = await cloudflareUpdateContinuation(session, state, 'default');
    expect(next).toEqual({ next: same.id, then: [] });
    // Someone else's return, or a state that does not match, continues nothing.
    expect(await cloudflareUpdateContinuation({ orgId: ORG, userId: 'intruder' }, state, 'default')).toBeNull();
    expect(await cloudflareUpdateContinuation(session, 'x'.repeat(43), 'default')).toBeNull();

    // The second consent is its own grant: tokens are never copied between connections.
    const second = await startCloudflareConnection(session, next!.next, false, false, { then: next!.then });
    const secondState = new URL(second.url).searchParams.get('state')!;
    expect(requested(second.url)).toEqual(expect.arrayContaining(NEW_SCOPES));
    await finishCloudflareConnection(session, { state: secondState, browser: second.browser, code: 'synthetic-code-2' }, cloudflare(() => requested(second.url).join(' ')));
    expect(await cloudflareUpdateContinuation(session, secondState, same.id)).toBeNull();
    expect((await cloudflarePermissionReport(ORG, same.id)).permission_update.required).toBe(false);
    expect((await cloudflarePermissionReport(ORG, other.id)).permission_update).toMatchObject({ required: true, hosting_group_ids: [other.id] });
  });

  it('refuses an API token connection, which gets its permissions in Cloudflare instead', async () => {
    await getStore().setDoc(connectionPath(ORG, 'cloudflare'), { status: 'connected', revision: 'r', auth_method: 'api_token',
      cloudflare: { account_id: ACCOUNT.id, account_name: ACCOUNT.name, bucket: '', endpoint: '' }, encrypted_credentials: sealCredentials(ORG, 'cloudflare', { api_token: 't' }) });
    await expect(startCloudflarePermissionUpdate(session, 'default')).rejects.toMatchObject({ code: 'api_token_connection' });
  });
});

describe('optional capabilities in diagnostics', () => {
  it('names the missing scopes and the one permission update when the deployment requests them', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', ENABLE_ALL);
    await oauthConnection('default', `${BASE} account-analytics.read`);
    const report = await cloudflarePermissionReport(ORG, 'default');
    expect(report).toMatchObject({ connected: true, account_id: ACCOUNT.id, auth_method: 'oauth', requested_optional_scopes: NEW_SCOPES });
    const byId = Object.fromEntries(report.capabilities.map(item => [item.capability, item]));
    expect(byId.analytics_provisioning).toMatchObject({ status: 'approval_required', missing_scopes: ['account-settings.write'] });
    expect(byId.analytics_reports).toMatchObject({ status: 'available', missing_scopes: [], next_step: null });
    expect(byId.redirect_rules).toMatchObject({ status: 'approval_required', missing_scopes: ['dynamic-redirect.read', 'dynamic-redirect.write'] });
    expect(byId.redirect_rules.next_step).toContain('Approve update');
    expect(report.permission_update).toMatchObject({ required: true, missing_scopes: ['account-settings.write', 'dynamic-redirect.read', 'dynamic-redirect.write'],
      action: { kind: 'approve_update', label: 'Approve update' }, connect_url: 'http://localhost/app/settings/publishing#cloudflare' });
    expect(report.permission_update.next_step).toContain('enables Analytics for no Site');
  });

  it('says the operator must enable a scope the deployment does not request, and asks for no update', async () => {
    await oauthConnection('default', BASE);
    const report = await cloudflarePermissionReport(ORG, 'default');
    expect(report.permission_update.required).toBe(false);
    expect(report.capabilities.every(item => item.status === 'not_offered')).toBe(true);
    expect(report.capabilities.find(item => item.capability === 'redirect_rules')!.next_step).toContain('redirect_rule_required');
    expect(report.capabilities[0].next_step).toContain('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES');
  });

  it('reports API token connections as checked on use, and unconnected Hosting Groups', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', ENABLE_ALL);
    const group = await saveHostingGroup(ORG, { name: 'Tokens', dns_mode: 'automatic' });
    await getStore().setDoc(connectionPath(ORG, 'cloudflare', group.id), { status: 'connected', revision: 'r', auth_method: 'api_token',
      cloudflare: { account_id: OTHER.id, account_name: OTHER.name, bucket: '', endpoint: '' }, encrypted_credentials: sealCredentials(ORG, 'cloudflare', { api_token: 't' }, group.id) });
    const reports = await cloudflarePermissionReports(ORG);
    expect(reports.map(item => item.hosting_group_id)).toEqual(['default', group.id]);
    expect(reports[0].capabilities.every(item => item.status === 'connection_required')).toBe(true);
    expect(reports[1].capabilities.every(item => item.status === 'unknown')).toBe(true);
    expect(reports[1].capabilities.find(item => item.capability === 'redirect_rules')!.next_step).toContain('Zone → Single Redirect → Edit');
    expect(reports[1].permission_update.connect_url).toBe(`http://localhost/app/settings/publishing#hosting-${group.id}`);
  });

  it('is returned by the public API for connections and the Cloudflare diagnosis', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', ENABLE_ALL);
    await oauthConnection('default', BASE);
    const { createApiKey } = await import('../../lib/api-keys');
    const token = (await createApiKey({ orgId: ORG, siteId: null, name: 'agent', createdBy: 'owner@example.test' })).token;
    const headers = { authorization: `Bearer ${token}` };
    const connections = await (await import('../../pages/api/v1/publishing/connections/index')).GET({ request: new Request('http://localhost/api/v1/publishing/connections', { headers }), params: {} } as never) as Response;
    const body = await connections.json();
    expect(body.cloudflare_permissions[0]).toMatchObject({ hosting_group_id: 'default', permission_update: { required: true, missing_scopes: NEW_SCOPES } });
    const diagnosis = await (await import('../../pages/api/v1/publishing/cloudflare-diagnosis')).GET({ request: new Request('http://localhost/api/v1/publishing/cloudflare-diagnosis', { headers }) } as never) as Response;
    expect((await diagnosis.json()).permissions).toMatchObject({ hosting_group_id: 'default', permission_update: { required: true } });
    expect(JSON.stringify(body)).not.toContain('old-default');
  });
});
