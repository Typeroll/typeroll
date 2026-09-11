import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { githubConfiguration } from './github-connection';
import { ConnectionError, connectionPath, getConnection, openCredentials, sealCredentials, type Connection } from './connections';
import { assertInstallation, createProviderClient, ProviderError, githubAppClient, type ProviderClient } from './providers.mjs';

/** Kept only for personal repository creation; all publishing uses installation tokens. */
export interface GithubUserGrant {
  access_token: string; refresh_token: string; expires_at: number; refresh_expires_at: number;
  user_id: string; app_id: string; client_id: string;
}
export function githubUserGrant(body: any, userId: string): GithubUserGrant {
  const config = githubConfiguration();
  if (!body || typeof body !== 'object' || typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token ||
      !Number.isSafeInteger(body.expires_in) || body.expires_in <= 60 || !Number.isSafeInteger(body.refresh_token_expires_in) || body.refresh_token_expires_in <= body.expires_in) {
    throw new ConnectionError('Personal GitHub accounts require expiring user authorization. Enable user-to-server token expiration in the publisher App and connect again.', 409, 'github_expiring_authorization_required');
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + body.expires_in * 1000,
    refresh_expires_at: Date.now() + body.refresh_token_expires_in * 1000, user_id: userId, app_id: config.appId, client_id: config.clientId };
}
const reconnect = () => new ConnectionError('Reconnect GitHub in Publishing to allow new repositories in your personal account. Existing repositories are kept.', 409, 'github_reauthorization_required');
function matches(connection: Connection, expected: NonNullable<Connection['github']>) {
  return connection.status === 'connected' && connection.github?.account_type === 'User' &&
    connection.github.account_id === expected.account_id && connection.github.installation_id === expected.installation_id &&
    connection.github.app_id === expected.app_id && connection.github.owner === expected.owner;
}
async function requireReconnect(org: string, revision: string): Promise<never> {
  await getStore().compareAndUpdateDoc<Connection>(connectionPath(org, 'github'), value => value.revision === revision,
    { github_authorization_required: true });
  throw reconnect();
}
async function userAccess(org: string, expected: NonNullable<Connection['github']>, fetchImpl: typeof fetch, rejectedToken?: string) {
  const store = getStore(), path = connectionPath(org, 'github'), config = githubConfiguration();
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await getConnection(org, 'github');
    if (!matches(current, expected)) throw new ConnectionError('The GitHub account changed. Start again.', 409);
    if (!current.encrypted_credentials || current.github_authorization_required) throw reconnect();
    const grant = openCredentials<GithubUserGrant>(org, 'github', current.encrypted_credentials);
    if (grant.user_id !== expected.account_id || grant.app_id !== config.appId || grant.client_id !== config.clientId) throw reconnect();
    if (grant.expires_at > Date.now() + 60_000 && grant.access_token !== rejectedToken) return { token: grant.access_token, revision: current.revision };
    if (!(grant.refresh_expires_at > Date.now())) return requireReconnect(org, current.revision);
    const lease = randomUUID();
    const acquired = await store.compareAndUpdateDoc<Connection>(path, value => matches(value, expected) && value.revision === current.revision &&
      value.encrypted_credentials === current.encrypted_credentials && (!value.refresh_lease || value.refresh_lease.expires_at <= Date.now()),
    { refresh_lease: { id: lease, expires_at: Date.now() + 45_000 } });
    if (!acquired) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
    try {
      let response: Response, body: any;
      try {
        response = await fetchImpl('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: grant.refresh_token }) });
        body = await response.json();
      } catch { throw new ConnectionError('GitHub authorization could not be renewed. Try again shortly.', 502, 'github_refresh_unavailable'); }
      if (response.status === 401 || ['bad_refresh_token', 'invalid_grant'].includes(body.error)) return await requireReconnect(org, current.revision);
      if (!response.ok || body.error) throw new ConnectionError('GitHub authorization could not be renewed. Try again shortly.', 502, 'github_refresh_unavailable');
      const renewed = githubUserGrant(body, grant.user_id);
      const saved = await store.compareAndUpdateDoc<Connection>(path, value => matches(value, expected) && value.revision === current.revision && value.refresh_lease?.id === lease,
        { encrypted_credentials: sealCredentials(org, 'github', renewed), refresh_lease: null, github_authorization_required: false });
      if (!saved) throw new ConnectionError('The GitHub connection changed during authorization renewal.', 409);
      return { token: renewed.access_token, revision: current.revision };
    } finally {
      await store.compareAndUpdateDoc<Connection>(path, value => value.refresh_lease?.id === lease, { refresh_lease: null });
    }
  }
  throw new ConnectionError('GitHub authorization is being renewed. Try again shortly.', 503, 'github_refresh_busy');
}

/** Only this operation needs a user token. Never expose a general user-authorized client. */
export async function createGithubRepository(org: string, github: ProviderClient, expected: NonNullable<Connection['github']>, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  if ((expected.account_type ?? 'Organization') === 'Organization') return github(`/orgs/${encodeURIComponent(expected.owner)}/repos`, { method: 'POST', body });
  let rejectedToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const access = await userAccess(org, expected, fetchImpl, rejectedToken), client = createProviderClient('GitHub', access.token, fetchImpl);
    try {
      const user = await client('/user');
      if (String(user.id) !== expected.account_id || user.login?.toLowerCase() !== expected.owner.toLowerCase()) throw reconnect();
      // Verify this installation directly with App authority too; callers must not supply arbitrary account identities.
      const app = githubAppClient(githubConfiguration(), fetchImpl);
      const installed = await app(`/app/installations/${expected.installation_id}`);
      assertInstallation(installed, { appId: expected.app_id, installationId: expected.installation_id, owner: expected.owner });
      if (installed.account.type !== 'User' || String(installed.account.id) !== user.id.toString()) throw reconnect();
      const current = await getConnection(org, 'github');
      if (!matches(current, expected) || current.revision !== access.revision) throw new ConnectionError('The GitHub connection changed. Start again.', 409);
      const result = await client('/user/repos', { method: 'POST', body });
      if (String(result.owner?.id) !== expected.account_id || result.name !== body.name || result.private !== true) throw new ConnectionError('GitHub returned an unexpected repository identity.', 502);
      return result;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 401) {
        if (attempt === 0) { rejectedToken = access.token; continue; }
        return requireReconnect(org, access.revision);
      }
      throw error;
    }
  }
  throw reconnect();
}
