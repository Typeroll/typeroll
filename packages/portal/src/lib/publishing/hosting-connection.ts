import { claimAccount, ConnectionError, connectionSummary, disconnect, getConnection, saveConnection, sealCredentials } from './connections';
import { getHostingGroup, hostingGroupId } from './hosting-groups';
import { createProviderClient } from './providers.mjs';

/** API clients may bring provider credentials instead of completing browser OAuth. */
export async function updateHostingConnection(orgId: string, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  const id = hostingGroupId(input.hosting_group_id);
  await getHostingGroup(orgId, id);
  if (id === 'default') throw new ConnectionError('Default reuses the organization media and DNS connection. Manage that connection in organization Publishing.', 409);
  const current = await getConnection(orgId, 'cloudflare', id);
  if (typeof input.revision !== 'string' || input.revision !== current.revision) throw new ConnectionError('The hosting connection changed. Reload before saving.', 409);
  if (input.action === 'disconnect') {
    await disconnect(orgId, 'cloudflare', input.revision, id);
  } else {
    const { account_id, api_token } = input;
    if (input.action !== 'connect' || typeof account_id !== 'string' || !/^[a-f0-9]{32}$/.test(account_id) || typeof api_token !== 'string' || !api_token || api_token.length > 16384 || /\s/.test(api_token)) {
      throw new ConnectionError('Provide a Cloudflare Account ID and API token with Account Read and Pages Edit access.', 400);
    }
    if (current.cloudflare && current.cloudflare.account_id !== account_id) throw new ConnectionError('Reconnect the same account. Use a new Hosting Group for a different account.', 409);
    const provider = createProviderClient('Cloudflare', api_token, fetchImpl);
    const account = await provider(`/accounts/${account_id}`);
    if (account.id !== account_id || typeof account.name !== 'string') throw new ConnectionError('Cloudflare account verification failed.', 502);
    await provider(`/accounts/${account_id}/pages/projects?per_page=1`);
    await claimAccount(orgId, 'cloudflare', account_id);
    await saveConnection(orgId, 'cloudflare', current.revision, {
      status: 'connected', auth_method: 'api_token', refresh_lease: null, connected_at: new Date().toISOString(),
      cloudflare: { account_id, account_name: account.name.slice(0, 200), bucket: '', endpoint: `https://${account_id}.r2.cloudflarestorage.com` },
      encrypted_credentials: sealCredentials(orgId, 'cloudflare', { api_token }, id),
    }, id);
  }
  return connectionSummary(await getConnection(orgId, 'cloudflare', id));
}
