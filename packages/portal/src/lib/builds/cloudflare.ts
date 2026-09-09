import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { cloudflareClient } from '../publishing/cloudflare-oauth';
import { getConnection, ConnectionError } from '../publishing/connections';
import { ProviderError, digest, type ProviderClient } from '../publishing/providers.mjs';
import { BUILD_PROTOCOL, BUILD_RUNTIME } from './contract.mjs';

export const enginePath = (org: string, provider: 'cloudflare' | 'github' = 'cloudflare') => `organizations/${org}/publishing/${provider === 'github' ? 'github_build_engine' : 'build_engine'}`;
export interface BuildEngine {
  revision: string;
  provider: 'cloudflare' | 'github';
  enabled: boolean;
  account_id: string | null;
  account_name: string | null;
  state: 'not_configured' | 'approval_required' | 'build_token_required' | 'setup_required' | 'qualification_required' | 'ready' | 'error';
  checked_at: string | null;
  issue: { code: string; message: string; http_status?: number; provider_codes?: number[] } | null;
  worker_name: string;
  worker_found?: boolean;
  runner_repo: string;
  protocol: number;
  node_version: string;
}
export async function readBuildEngine(org: string): Promise<BuildEngine> {
  const name = `typeroll-builder-${digest(org).slice(0, 16)}`;
  return await getStore().getDoc<BuildEngine>(enginePath(org)) ?? {
    revision: 'initial', provider: 'cloudflare', enabled: false, account_id: null, account_name: null,
    state: 'not_configured', checked_at: null, issue: null, worker_name: name, runner_repo: name,
    protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME,
  };
}

/** Read provider capabilities without creating a Worker, Git repository or deployment. */
export async function inspectCloudflareBuildAccess(client: ProviderClient, account: string, workerName?: string) {
  const issues: Array<{ resource: 'workers' | 'builds'; http_status: number; provider_codes: number[] }> = [];
  const results = await Promise.allSettled([
    client(`/accounts/${account}/workers/scripts`), client(`/accounts/${account}/builds/tokens`),
  ]);
  const counts: number[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (!Array.isArray(result.value)) throw new ConnectionError('Cloudflare returned an invalid build setup response.', 502, 'build_provider_response_invalid');
      counts.push(result.value.length);
    } else if (result.reason instanceof ProviderError) {
      issues.push({ resource: index ? 'builds' : 'workers', http_status: result.reason.status, provider_codes: result.reason.codes });
      counts.push(0);
    } else throw result.reason;
  });
  // Never return build tokens or provider credential metadata through the API.
  const workers = results[0];
  const workerFound = workers.status === 'fulfilled' && workers.value.some((worker: { id?: string }) => workerName !== undefined && worker?.id === workerName);
  return { issues, workers: counts[0], build_tokens: counts[1], worker_found: workerFound };
}

export async function checkBuildEngine(org: string, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  const previous = await readBuildEngine(org);
  if (input.revision !== previous.revision) throw new ConnectionError('Build settings changed. Reload and try again.', 409, 'build_settings_changed');
  const connection = await getConnection(org, 'cloudflare');
  if (connection.status !== 'connected' || !connection.cloudflare) throw new ConnectionError('Connect the organization Cloudflare account in Publishing first.', 409, 'build_account_required');
  let next: BuildEngine = { ...previous, revision: randomUUID(), enabled: false,
    account_id: connection.cloudflare.account_id, account_name: connection.cloudflare.account_name,
    checked_at: new Date().toISOString(), worker_found: false, state: 'qualification_required', issue: null };
  try {
    const client = await cloudflareClient(org, fetchImpl);
    const access = await inspectCloudflareBuildAccess(client, connection.cloudflare.account_id, previous.worker_name);
    next.worker_found = access.worker_found;
    if (access.issues.length) {
      const denied = access.issues.find(issue => [401, 403].includes(issue.http_status));
      const issue = denied ?? access.issues[0];
      next = { ...next, state: denied ? 'approval_required' : 'error', issue: {
        code: denied ? 'build_permission_required' : 'build_provider_unavailable', http_status: issue.http_status, provider_codes: issue.provider_codes,
        message: denied ? `Cloudflare denied access to ${issue.resource === 'workers' ? 'Workers Scripts' : 'Workers Builds'} in ${connection.cloudflare.account_name} (HTTP ${issue.http_status}${issue.provider_codes.length ? `, code ${issue.provider_codes.join(', ')}` : ''}). Approve build permissions for the existing organization connection. Your hosting accounts and media stay connected.` :
          `Cloudflare could not check ${issue.resource} (HTTP ${issue.http_status}). Try checking again.`,
      } };
    } else if (!access.build_tokens) next = { ...next, state: 'build_token_required', issue: { code: 'build_token_required',
      message: 'Build permissions are approved. Cloudflare has not reported a build token for this account yet. Complete the one-time setup in Cloudflare, then check again. Reconnecting your account will not create the token.' } };
    else next = { ...next, state: 'qualification_required', issue: { code: 'build_qualification_required',
      message: 'Build token found. The shared build engine still needs to complete its setup and verification before it can publish sites. No further permission approval is needed.' } };
    if (!access.issues.length && access.worker_found && access.build_tokens) {
      const installed = await getStore().getDoc<{ status: string; account_id: string }>(`organizations/${org}/publishing_private/build_engine`);
      if (installed?.status === 'ready' && installed.account_id === connection.cloudflare.account_id) next = { ...next, state: 'ready', enabled: true, issue: null };
    }
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    next = { ...next, state: 'error', issue: { code: error.code ?? 'build_connection_failed', message: error.message } };
  }
  await getStore().createDocIfMissing(enginePath(org), previous);
  if (!await getStore().compareAndUpdateDoc<BuildEngine>(enginePath(org), current => current.revision === previous.revision, next))
    throw new ConnectionError('Build settings changed. Check again.', 409, 'build_settings_changed');
  return next;
}

/** Both manual dispatch and cancellation target the single organization engine. */
export async function dispatchCloudflareBuild(client: ProviderClient, target: { account_id: string; trigger_uuid: string; runner_commit: string }) {
  if (!/^[a-f0-9]{32}$/.test(target.account_id) || !/^[a-f0-9-]{36}$/.test(target.trigger_uuid) || !/^[a-f0-9]{40}$/.test(target.runner_commit)) throw new Error('Invalid organization build target');
  const result = await client(`/accounts/${target.account_id}/builds/triggers/${target.trigger_uuid}/builds`, {
    method: 'POST', body: { branch: 'main', commit_hash: target.runner_commit },
  });
  if (!/^[a-f0-9-]{36}$/.test(result?.build_uuid ?? '')) throw new ConnectionError('Cloudflare did not return a build identity. Check the running builds before retrying.', 502, 'build_dispatch_uncertain');
  return result.build_uuid as string;
}
