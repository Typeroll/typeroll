import { paths, type DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { cloudflareClient } from '../publishing/cloudflare-oauth';
import { dispatchCloudflareBuild } from './cloudflare';
import { BUILD_PROTOCOL, BUILD_RUNTIME, encodeSource, sha256, decodeArtifact, type BuildIdentity } from './contract.mjs';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from './queue';
import { readEngineConfiguration, buildInputPath, type BuildInput, type EngineConfiguration } from './state';
import { buildStorage } from './storage';

export async function enqueueBuild(config: EngineConfiguration, identity: Omit<BuildIdentity, 'source_sha256' | 'protocol' | 'node_version'>, files: Record<string, string>, kind: BuildInput['kind'] = 'publication') {
  const source = encodeSource(files);
  const frozen: BuildIdentity = { ...identity, source_sha256: sha256(source), protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME };
  const sourceKey = `builds/${identity.org_id}/sources/${frozen.source_sha256}.json`;
  await buildStorage(identity.org_id, async storage => {
    if (storage.account !== config.account_id) throw new ConnectionError('Build storage changed. Set up the shared engine again.', 409);
    await storage.put(sourceKey, source);
  });
  const queued = await new OrganizationBuildQueue().enqueue(frozen, config.revision);
  await getStore().createDocIfMissing(buildInputPath(identity.org_id, queued.key), { source_key: sourceKey, kind, storage_account_id: config.account_id } satisfies BuildInput);
  await dispatchPendingBuild(identity.org_id, queued.key, config);
  return queued;
}

/** Explicit dispatch is serialized separately from claims; retries never change the frozen source. */
export async function dispatchPendingBuild(org: string, key: string, config: EngineConfiguration) {
  const store = getStore(), inputPath = buildInputPath(org, key);
  const task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  const input = await store.getDoc<BuildInput>(inputPath);
  if (!task || !input || !['queued', 'running'].includes(task.status) || task.lease_until > Date.now()) return;
  if (task.deadline <= Date.now() || task.attempt >= 3) throw new ConnectionError('The shared build timed out. Retry the publication.', 409, 'shared_build_timeout');
  const client = await cloudflareClient(org);
  if (input.dispatch_uncertain) {
    // A timeout can occur after Cloudflare accepted the request. Recover its identity
    // before any retry; an empty history is not permission to submit another build.
    const history = await client(`/accounts/${config.account_id}/builds/workers/${config.worker_tag}/builds`);
    const started = input.dispatch_started_at ?? 0;
    const recovered = history.find((build: any) => build.build_trigger_metadata?.commit_hash === config.runner_commit &&
      build.build_trigger_metadata?.branch === 'main' && Date.parse(build.created_on) >= started - 5000);
    if (recovered?.build_uuid) await store.compareAndUpdateDoc<BuildInput>(inputPath,
      value => value.dispatch_uncertain === true && value.dispatch_started_at === started,
      { dispatch_id: recovered.build_uuid, dispatch_uncertain: false });
    return;
  }
  if (input.dispatch_id) {
    const providerBuild = await client(`/accounts/${config.account_id}/builds/builds/${input.dispatch_id}`);
    if (providerBuild.status !== 'stopped') return;
    // A runner can claim another queued job in the same organization. A stopped dispatch
    // is not proof this task ran; only its attempt lease establishes ownership.
  }
  const now = Date.now();
  const won = await store.compareAndUpdateDoc<BuildInput>(inputPath, current =>
    (current.dispatch_lease_until ?? 0) <= now && current.dispatch_id === input.dispatch_id && !current.dispatch_uncertain,
    { dispatch_uncertain: true, dispatch_started_at: now, dispatch_lease_until: now + 120000, dispatch_attempt: (input.dispatch_attempt ?? 0) + 1 });
  if (!won) return;
  if ((input.dispatch_attempt ?? 0) >= 3) throw new ConnectionError('Cloudflare could not start the shared runner. Open Publishing → Builds and check the build project.', 502, 'shared_runner_start_failed');
  // Keep the lease after an uncertain provider response. Do not immediately submit a duplicate.
  try {
    const id = await dispatchCloudflareBuild(client, { account_id: config.account_id, trigger_uuid: config.trigger_uuid, runner_commit: config.runner_commit });
    await store.updateDoc(inputPath, { dispatch_id: id, dispatch_uncertain: false, dispatch_lease_until: now + 120000 });
  } catch { /* Preserve uncertainty until provider history or a claimed task establishes the outcome. */ }
}

export async function completedBuild(org: string, key: string) {
  const task = await getStore().getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  if (!task) throw new ConnectionError('The frozen build was not found.', 409);
  if (['failed', 'cancelled'].includes(task.status)) throw new ConnectionError(`The shared build stopped (${task.error_code ?? task.status}). Retry the publication.`, 502, task.error_code ?? 'shared_build_failed');
  if (task.status !== 'completed') {
    const config = await readEngineConfiguration(org);
    if (!config || config.revision !== task.engine_revision || !['ready', 'qualifying'].includes(config.status)) throw new ConnectionError('The shared build engine changed. Retry the publication.', 409);
    await dispatchPendingBuild(org, key, config); return null;
  }
  const files = await buildStorage(org, async storage => decodeArtifact(await storage.read(task.artifact_key!), task.identity, task.artifact_sha256!));
  return { task, files };
}

export async function publicationStillRunning(task: BuildTask) {
  const job = await getStore().getDoc<DeployJob>(paths.deploy(task.identity.org_id, task.identity.site_id, task.identity.job_id));
  return !!job && ['queued', 'running'].includes(job.status) && job.version_id === task.identity.version_id;
}
