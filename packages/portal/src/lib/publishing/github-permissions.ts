import { githubConfiguration } from './github-connection';
import { assertInstallation, githubAppClient } from './providers.mjs';
import { ConnectionError, getConnection } from './connections';

export interface GithubPermissions {
  revision: string;
  state: 'up_to_date' | 'approval_required' | 'publisher_update_required';
  approval_url: string | null;
  message: string;
  missing_permissions: string[];
}

/** Check live grants without reconnecting, changing revisions or minting access tokens. */
export async function checkGithubPermissions(org: string, fetchImpl: typeof fetch = fetch): Promise<GithubPermissions> {
  const connection = await getConnection(org, 'github');
  if (connection.status !== 'connected' || !connection.github) throw new ConnectionError('Connect GitHub first.', 409);
  const config = githubConfiguration(), saved = connection.github;
  if (saved.app_id !== config.appId) throw new ConnectionError('The GitHub publisher configuration changed.', 409);
  const client = githubAppClient(config, fetchImpl);
  const [app, installation] = await Promise.all([client('/app'), client(`/app/installations/${saved.installation_id}`)]);
  assertInstallation(installation, { appId: config.appId, installationId: saved.installation_id, owner: saved.owner });
  if (String(app.id) !== config.appId || String(installation.account.id) !== saved.account_id) throw new ConnectionError('The GitHub organization identity changed.', 409);
  if ((await getConnection(org, 'github')).revision !== connection.revision) throw new ConnectionError('The GitHub connection changed. Check again.', 409);
  const missing = ['actions', 'workflows'].filter(name => installation.permissions?.[name] !== 'write');
  const unavailable = missing.some(name => app.permissions?.[name] !== 'write');
  const state = unavailable ? 'publisher_update_required' : missing.length ? 'approval_required' : 'up_to_date';
  // Identity comes from the authenticated installation, never a browser-supplied URL.
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(saved.owner) || !/^\d+$/.test(saved.installation_id)) throw new ConnectionError('Invalid GitHub installation.', 409);
  return {
    revision: connection.revision, state, missing_permissions: missing,
    approval_url: state === 'approval_required' ? `https://github.com/organizations/${saved.owner}/settings/installations/${saved.installation_id}` : null,
    message: state === 'up_to_date' ? 'GitHub permissions are up to date. Your existing connection is active.'
      : state === 'approval_required' ? 'Approve the requested update in GitHub. Typeroll will check automatically when you return. You do not need to disconnect or reconnect.'
      : 'Typeroll needs to enable GitHub build access before you can approve it. No action is needed from you yet. Your existing connection remains active.',
  };
}
