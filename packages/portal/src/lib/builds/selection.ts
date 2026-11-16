import { buildActivity, cancelGithubTask } from './activity';
import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { readBuildEngine } from './cloudflare';
import { readGithubEngine, configureGithubEngine } from './github';
import { configureBuildEngine } from './setup';
import { readEngineConfiguration, assertEngineConnections, selectionPath, engineRunsCurrentRuntime, engineRuntime, type BuildProvider, type BuildSelection, type EngineConfiguration } from './state';
export { engineRunsCurrentRuntime, engineRuntime };
import { CLOUDFLARE_ENGINE_SOURCE } from './setup';
import { GITHUB_ENGINE_SOURCE } from './github-source';
import { BUILD_RUNTIME } from './contract.mjs';

export { selectionPath, type BuildSelection };
export async function readBuildSelection(org: string): Promise<BuildSelection & { auto_update: boolean }> {
  const selection: BuildSelection = await getStore().getDoc<BuildSelection>(selectionPath(org)) ?? { provider: 'cloudflare', revision: 'initial' };
  return { ...selection, auto_update: selection.auto_update === true };
}
export async function selectedBuildProvider(org: string) { return (await readBuildSelection(org)).provider; }
/**
 * Why a ready engine should be updated, or null when it is current (or not
 * ready, when setup decides instead):
 * - capability_missing: it lacks a capability this Typeroll requires to publish;
 * - engine_source_changed: it runs older generated code than this Typeroll installs.
 * Engines in customer accounts never update themselves; with auto_update on,
 * the next publication updates an engine with either reason first.
 */
export type EngineUpdateReason = 'capability_missing' | 'engine_source_changed';
/**
 * The engine whose Node.js version builds run on now: the ready configuration,
 * or during an update the ready engine it replaces.
 */
function runningRuntime(config: EngineConfiguration | null): string | null {
  if (!config) return null;
  if (config.status === 'ready') return engineRuntime(config);
  return config.previous?.status === 'ready' ? engineRuntime(config.previous) : null;
}
/** Why an engine on an older Node.js cannot build this Typeroll, and what to do. */
export function engineRuntimeMessage(actual: string, autoUpdate: boolean): string {
  return `The build engine runs Node.js ${actual}; this Typeroll builds with Node.js ${BUILD_RUNTIME}. `
    + (autoUpdate ? 'The next publication updates the engine before it builds.' : 'Update the build engine in Publishing → Builds (setup_organization_build_engine), or turn on automatic engine updates, before publishing.');
}
/** A stale selection.revision; the refusal carries the current one to retry with. */
function selectionChanged(selection: BuildSelection) {
  return new ConnectionError('Build settings changed. Retry with current_revision.', 409, 'build_settings_changed', { current_revision: selection.revision });
}
export function engineUpdateReason(config: EngineConfiguration | null | undefined): EngineUpdateReason | null {
  if (!config || config.status !== 'ready') return null;
  if (!config.static_verification || !config.media_preparation || config.publication_validation !== 1) return 'capability_missing';
  // Every build step is bound to BUILD_RUNTIME and the engine's executor runs only
  // on its own Node.js version, so an engine on an older runtime cannot build.
  if (!engineRunsCurrentRuntime(config)) return 'capability_missing';
  const source = (config.provider ?? 'cloudflare') === 'github' ? GITHUB_ENGINE_SOURCE : CLOUDFLARE_ENGINE_SOURCE;
  return config.engine_source_sha256 !== source ? 'engine_source_changed' : null;
}

/**
 * The Node.js version the selected engine builds with against the one this
 * Typeroll requires, for publication previews. `blocks_publication` means a
 * publication is refused until an admin updates the engine; with automatic
 * updates on, the publication updates it first.
 */
export async function buildEngineRuntime(org: string) {
  const selection = await readBuildSelection(org);
  const config = await readEngineConfiguration(org, selection.provider);
  const reason = engineUpdateReason(config && { ...config, provider: selection.provider });
  const node = runningRuntime(config);
  const behind = node !== null && node !== BUILD_RUNTIME;
  return { provider: selection.provider, node_version: node, required_node_version: BUILD_RUNTIME, update_reason: reason, auto_update: selection.auto_update,
    blocks_publication: reason === 'capability_missing' && !selection.auto_update,
    ...(behind ? { message: engineRuntimeMessage(node, selection.auto_update) } : {}) };
}
export async function readBuildSettings(org: string) {
  const [selection, cloudflare, github] = await Promise.all([readBuildSelection(org), readBuildEngine(org), readGithubEngine(org)]);
  const engines = { cloudflare, github };
  for (const provider of ['cloudflare', 'github'] as const) {
    // The saved configuration may predate the provider field; the engine read here is this provider's.
    const config = await readEngineConfiguration(org, provider);
    const reason = engineUpdateReason(config && { ...config, provider });
    // The saved engine document keeps the Node.js version of its first setup; the configuration is what builds run on.
    const node = runningRuntime(config) ?? engines[provider].node_version;
    engines[provider] = { ...engines[provider], node_version: node, required_node_version: BUILD_RUNTIME, update_available: reason !== null, update_reason: reason };
    if (reason === 'capability_missing') {
      engines[provider] = { ...engines[provider], enabled: false, state: 'setup_required', issue: {
        code: 'build_engine_update_required', message: config && !engineRunsCurrentRuntime(config) ? engineRuntimeMessage(node, selection.auto_update)
          : 'Update the build engine before publishing. Finish build setup to install and verify the required capabilities.',
      } };
    }
  }
  // Keep the existing top-level selected-engine fields for older API clients.
  return { ...engines[selection.provider], selection, engines, ...await buildActivity(org) };
}
export async function configureBuildSettings(org: string, input: Record<string, unknown>) {
  if (input.provider !== undefined && input.provider !== 'cloudflare' && input.provider !== 'github') throw new ConnectionError('Choose Cloudflare or GitHub.', 400);
  const provider: BuildProvider = input.provider as BuildProvider ?? 'cloudflare';
  if (input.action === 'cancel') {
    await cancelGithubTask(org, String(input.key));
    return readBuildSettings(org);
  }
  if (input.action === 'auto_update') {
    if (typeof input.enabled !== 'boolean') throw new ConnectionError('Send enabled: true or false.', 400);
    const selection = await readBuildSelection(org);
    if (input.revision !== selection.revision) throw selectionChanged(selection);
    const store = getStore();
    await store.createDocIfMissing(selectionPath(org), { provider: selection.provider, revision: selection.revision });
    if (!await store.compareAndUpdateDoc<BuildSelection>(selectionPath(org), value => value.revision === selection.revision, { auto_update: input.enabled, revision: randomUUID() }))
      throw selectionChanged(await readBuildSelection(org));
    return readBuildSettings(org);
  }
  if (input.action === 'select') {
    const selection = await readBuildSelection(org);
    if (input.revision !== selection.revision) throw selectionChanged(selection);
    const engine = await readEngineConfiguration(org, provider);
    const visible = provider === 'github' ? await readGithubEngine(org) : await readBuildEngine(org);
    if (!engine || engine.status !== 'ready' || !visible.enabled || visible.state !== 'ready') throw new ConnectionError('Finish setup and verification for this build provider before selecting it.', 409, 'build_provider_not_ready');
    await assertEngineConnections(org, engine);
    const store = getStore();
    await store.createDocIfMissing(selectionPath(org), selection);
    if (!await store.compareAndUpdateDoc<BuildSelection>(selectionPath(org), value => value.revision === selection.revision, { provider, revision: randomUUID() })) throw selectionChanged(await readBuildSelection(org));
  } else if (provider === 'github') await configureGithubEngine(org, input);
  else await configureBuildEngine(org, input);
  return readBuildSettings(org);
}
