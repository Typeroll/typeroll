import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { decryptSecret } from '../secret-crypto';
import { cloudflareClient } from '../publishing/cloudflare-oauth';
import { enginePath } from './cloudflare';
import { githubBuildClient, githubBuildRoot } from './github';
import { engineConfigurationPath, type EngineConfiguration } from './state';
import { sha256 } from './contract.mjs';

/**
 * Put back the ready engine an update replaced, on either provider.
 * Cloudflare dispatches every build at a pinned runner commit, so only the
 * trigger's runner token has to be restored. GitHub runs the workflow at the
 * head of main and authenticates runs by OIDC, so main is moved back to the
 * previous runner commit. Returns false, leaving the engine disabled, when
 * there is nothing to restore or the provider refuses.
 */
export async function restorePreviousEngine(org: string, failed: EngineConfiguration, issue: { code: string; message: string }): Promise<boolean> {
  const previous = failed.previous, provider = failed.provider ?? 'cloudflare';
  if (!previous || previous.status !== 'ready' || (previous.provider ?? 'cloudflare') !== provider || !/^[a-f0-9]{40}$/.test(previous.runner_commit)) return false;
  const store = getStore(), path = engineConfigurationPath(org, provider);
  try {
    if (provider === 'github') {
      if (!previous.github) return false;
      const client = await githubBuildClient(previous);
      await client(`${githubBuildRoot(previous)}/git/refs/heads/main`, { method: 'PATCH', body: { sha: previous.runner_commit, force: true } });
    } else {
      if (!previous.trigger_uuid) return false;
      const { token } = JSON.parse(decryptSecret(previous.encrypted_token)) as { org: string; token: string };
      if (!token || sha256(token) !== previous.token_hash) return false;
      const client = await cloudflareClient(org);
      await client(`/accounts/${previous.account_id}/builds/triggers/${previous.trigger_uuid}/environment_variables`, { method: 'PATCH', body: { TYPEROLL_RUNNER_TOKEN: { value: token, is_secret: true } } });
    }
    const current = await store.getDoc<EngineConfiguration>(path);
    if (!current || current.revision !== failed.revision || current.status === 'ready') return false;
    if (!await store.compareAndReplaceDoc(path, current, { ...previous, status: 'ready', setup_lease_until: 0, previous: null })) return false;
    await store.updateDoc(enginePath(org, provider), { revision: randomUUID(), state: 'ready', enabled: true, checked_at: new Date().toISOString(),
      issue: { code: 'build_engine_update_failed', message: `The build engine update did not finish (${issue.message.replace(/\.$/, '')}). The previous engine is back in use and publishing works as before. Run the update again from Publishing → Builds after resolving the cause.`, cause_code: issue.code } });
    console.info(JSON.stringify({ event: 'build_engine_restored', org_id: org, provider, failed_revision: failed.revision, restored_revision: previous.revision, cause: issue.code }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'build_engine_restore_failed', org_id: org, provider, failed_revision: failed.revision, error: error instanceof Error ? error.name : 'unknown' }));
    return false;
  }
}
