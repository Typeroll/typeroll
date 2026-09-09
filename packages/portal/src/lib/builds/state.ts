import { getStore } from '../datastore';
import { ConnectionError, getConnection } from '../publishing/connections';
import { equalToken } from './queue';

export type BuildProvider = 'cloudflare' | 'github';
export interface EngineConfiguration {
  provider?: BuildProvider;
  github?: { repository_id: string; owner_id: string; repo: string; app_bot: string; workflow_id: number };
  revision: string; account_id: string; owner: string; installation_id: string;
  worker_tag: string; trigger_uuid: string; runner_commit: string;
  token_hash: string; encrypted_token: string; status: 'preparing' | 'qualifying' | 'ready' | 'disabled';
  qualification_key?: string; provider_build_id?: string; setup_lease_until: number;
}
export const engineConfigurationPath = (org: string, provider: BuildProvider = 'cloudflare') => `organizations/${org}/publishing_private/${provider === 'github' ? 'github_build_engine' : 'build_engine'}`;
export const buildInputPath = (org: string, key: string) => `organizations/${org}/build_inputs/${key}`;
export interface BuildInput { provider?: BuildProvider; dispatch_nonce?: string; source_key: string; kind: 'qualification' | 'publication'; dispatch_id?: string; dispatch_uncertain?: boolean; dispatch_started_at?: number; dispatch_attempt?: number; dispatch_lease_until?: number; storage_account_id: string }
export async function readEngineConfiguration(org: string, provider: BuildProvider = 'cloudflare') { return getStore().getDoc<EngineConfiguration>(engineConfigurationPath(org, provider)); }
export async function authorizeEngine(org: string, token: string, revision: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(org)) throw new ConnectionError('Build engine authentication failed.', 401);
  const config = await readEngineConfiguration(org);
  if (!config || !['ready', 'qualifying'].includes(config.status) || config.revision !== revision || !equalToken(token, config.token_hash)) throw new ConnectionError('Build engine authentication failed.', 401);
  await assertEngineConnections(org, config);
  return config;
}
export async function assertEngineConnections(org: string, config: EngineConfiguration) {
  const [cf, github] = await Promise.all([getConnection(org, 'cloudflare'), getConnection(org, 'github')]);
  if (cf.status !== 'connected' || cf.cloudflare?.account_id !== config.account_id || github.status !== 'connected' || github.github?.installation_id !== config.installation_id ||
      (config.provider === 'github' && (github.github?.owner !== config.owner || github.github?.account_id !== config.github?.owner_id)))
    throw new ConnectionError('The organization publishing connection changed.', 409, 'build_connection_changed');
  return config;
}
