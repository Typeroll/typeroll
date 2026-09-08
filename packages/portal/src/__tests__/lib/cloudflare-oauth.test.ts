import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, connectionSummary, disconnect, getConnection, openCredentials, saveConnection, sealCredentials } from '../../lib/publishing/connections';
import { cloudflareClient, cloudflareChoices, CLOUDFLARE_SCOPES, finishCloudflareConnection, selectCloudflareAccount, startCloudflareConnection, type CloudflareStoredCredentials } from '../../lib/publishing/cloudflare-oauth';

const session = { userId: 'dev-user', email: 'dev@typeroll.local', orgId: 'default' };
const first = { id: 'a'.repeat(32), name: 'First agency' };
const second = { id: 'b'.repeat(32), name: 'Second agency' };
const token = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer', scope: CLOUDFLARE_SCOPES.join(' ') };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-secret');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function provider(accounts = [first], exchange = token) {
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe('error');
    const path = new URL(String(url)).pathname;
    if (path === '/oauth2/token') return Response.json(exchange);
    if (path === '/client/v4/accounts') return Response.json({ success: true, result: accounts });
    if (path.endsWith('/pages/projects')) return Response.json({ success: true, result: [] });
    const account = accounts.find(item => path === `/client/v4/accounts/${item.id}`);
    if (account) return Response.json({ success: true, result: account });
    throw new Error('Unexpected provider request');
  });
}
async function grant() {
  const started = await startCloudflareConnection(session);
  return { ...started, code: 'synthetic-code', state: new URL(started.url).searchParams.get('state')! };
}
it('discovers an authorized account with PKCE and persists only encrypted tokens', async () => {
  const input = await grant(), fetcher = provider();
  expect(await finishCloudflareConnection(session, input, fetcher)).toBe('connected');
  const parameters = new URLSearchParams(fetcher.mock.calls[0][1]?.body as string);
  expect(new URL(input.url).searchParams.get('code_challenge')).toBe(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url'));
  expect(parameters.get('redirect_uri')).toBe('http://localhost/api/orgs/publishing/cloudflare/callback');
  const connection = await getConnection('default', 'cloudflare');
  expect(connection).toMatchObject({ status: 'connected', auth_method: 'oauth', media_ready: false, cloudflare: { account_id: first.id, bucket: '' } });
  expect(JSON.stringify([connection, connectionSummary(connection)])).not.toContain('synthetic-access');
  expect(openCredentials<CloudflareStoredCredentials>('default', 'cloudflare', connection.encrypted_credentials!).oauth?.refresh_token).toBe('synthetic-refresh');
  expect(await getStore().getDoc('organizations/default/publishing_authorizations/cloudflare')).toMatchObject({ consumed: true, encrypted_verifier: null });
  await expect(finishCloudflareConnection(session, input, fetcher)).rejects.toThrow('expired');
});
it.each(['user', 'org', 'browser', 'state', 'expiry'])('rejects a mismatched %s before exchange', async kind => {
  const input = await grant(), fetcher = provider();
  if (kind === 'browser' || kind === 'state') input[kind] = 'x'.repeat(43);
  if (kind === 'expiry') await getStore().updateDoc('organizations/default/publishing_authorizations/cloudflare', { expires_at: 0 });
  await expect(finishCloudflareConnection({ ...session, ...(kind === 'user' ? { userId: 'another' } : {}), ...(kind === 'org' ? { orgId: 'another' } : {}) }, input, fetcher)).rejects.toThrow('expired');
  expect(fetcher).not.toHaveBeenCalled();
});
it('requires explicit selection of a proven account, bound to the same user', async () => {
  const fetcher = provider([first, second]);
  expect(await finishCloudflareConnection(session, await grant(), fetcher)).toBe('select');
  expect(await cloudflareChoices(session)).toEqual([first, second]);
  expect(await cloudflareChoices({ ...session, userId: 'another' })).toEqual([]);
  await expect(selectCloudflareAccount(session, 'c'.repeat(32), fetcher)).rejects.toThrow('expired');
  await expect(selectCloudflareAccount({ ...session, userId: 'another' }, second.id, fetcher)).rejects.toThrow('expired');
  await selectCloudflareAccount(session, second.id, fetcher);
  expect((await getConnection('default', 'cloudflare')).cloudflare?.account_id).toBe(second.id);
  await expect(selectCloudflareAccount(session, second.id, fetcher)).rejects.toThrow('expired');
  expect(await getStore().getDoc('organizations/default/publishing_authorizations/cloudflare_selection')).toMatchObject({ encrypted_tokens: null });
});
it('does not reconnect after disconnect or claim another tenant account', async () => {
  const input = await grant();
  await disconnect('default', 'cloudflare', (await getConnection('default', 'cloudflare')).revision);
  await expect(finishCloudflareConnection(session, input, provider())).rejects.toThrow('changed');
  await getStore().setDoc(`publishing_account_claims/cloudflare-${first.id}`, { org_id: 'another' });
  await expect(finishCloudflareConnection(session, await grant(), provider())).rejects.toThrow('another Typeroll');
});
it('rejects reduced scopes and credential-reflecting provider errors', async () => {
  await expect(finishCloudflareConnection(session, await grant(), provider([first], { ...token, scope: 'page.read' }))).rejects.toThrow('required permissions');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: 'synthetic-access' }, { status: 400 }));
  await expect(finishCloudflareConnection(session, await grant(), fetcher)).rejects.toThrow('Cloudflare authorization could not be completed');
  expect((await getConnection('default', 'cloudflare')).status).toBe('disconnected');
});
async function expire() {
  const connection = await getConnection('default', 'cloudflare');
  const credentials = openCredentials<CloudflareStoredCredentials>('default', 'cloudflare', connection.encrypted_credentials!);
  credentials.oauth!.expires_at = 0;
  await getStore().updateDoc(connectionPath('default', 'cloudflare'), { encrypted_credentials: sealCredentials('default', 'cloudflare', credentials) });
}
it('serializes rotating refresh tokens and reuses the new token', async () => {
  await finishCloudflareConnection(session, await grant(), provider()); await expire();
  const fetcher = provider([first], { ...token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
  const clients = await Promise.all([cloudflareClient('default', fetcher), cloudflareClient('default', fetcher)]);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
  for (const client of clients) await client(`/accounts/${first.id}`);
  expect((fetcher.mock.calls.at(-1)![1]?.headers as Record<string, string>).Authorization).toBe('Bearer rotated-access');
  const connection = await getConnection('default', 'cloudflare');
  expect(openCredentials<CloudflareStoredCredentials>('default', 'cloudflare', connection.encrypted_credentials!).oauth?.refresh_token).toBe('rotated-refresh');
  expect(connection.refresh_lease).toBeNull();
});
it('never resurrects a connection disconnected during refresh', async () => {
  await finishCloudflareConnection(session, await grant(), provider()); await expire();
  const fetcher = vi.fn<typeof fetch>(async () => {
    await disconnect('default', 'cloudflare', (await getConnection('default', 'cloudflare')).revision);
    return Response.json(token);
  });
  await expect(cloudflareClient('default', fetcher)).rejects.toThrow('changed');
  expect(await getConnection('default', 'cloudflare')).toMatchObject({ status: 'disconnected', encrypted_credentials: null, refresh_lease: null });
});
it('rejects a media credential save racing with rotating authorization', async () => {
  await finishCloudflareConnection(session, await grant(), provider()); await expire();
  const current = await getConnection('default', 'cloudflare');
  const fetcher = vi.fn<typeof fetch>(async () => {
    await expect(saveConnection('default', 'cloudflare', current.revision, {
      encrypted_credentials: current.encrypted_credentials, media_ready: true,
    })).rejects.toThrow('changed');
    return Response.json({ ...token, refresh_token: 'new-refresh' });
  });
  await cloudflareClient('default', fetcher);
  const saved = await getConnection('default', 'cloudflare');
  expect(openCredentials<CloudflareStoredCredentials>('default', 'cloudflare', saved.encrypted_credentials!).oauth?.refresh_token).toBe('new-refresh');
  expect(saved.revision).not.toBe(current.revision);
});
it('keeps the original account and media keys when reconnecting OAuth', async () => {
  await finishCloudflareConnection(session, await grant(), provider());
  const current = await getConnection('default', 'cloudflare');
  const credentials = openCredentials<CloudflareStoredCredentials>('default', 'cloudflare', current.encrypted_credentials!);
  await getStore().updateDoc(connectionPath('default', 'cloudflare'), { media_ready: true, cloudflare: { ...current.cloudflare, bucket: 'agency-media', public_bucket: 'public-media' },
    encrypted_credentials: sealCredentials('default', 'cloudflare', { ...credentials, access_key_id: 'synthetic-r2-key', secret_access_key: 'synthetic-r2-secret' }) });
  await finishCloudflareConnection(session, await grant(), provider([first, second]));
  const reconnected = await getConnection('default', 'cloudflare');
  expect(reconnected.media_ready).toBe(true);
  expect(reconnected.cloudflare?.account_id).toBe(first.id);
});

it('rejects a stale connection revision before using credentials', async () => {
  await finishCloudflareConnection(session, await grant(), provider());
  const fetcher = provider();
  await expect(cloudflareClient('default', fetcher, 'stale-revision')).rejects.toThrow('changed');
  expect(fetcher).not.toHaveBeenCalled();
});
