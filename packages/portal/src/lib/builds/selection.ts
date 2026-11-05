import { buildActivity, cancelGithubTask } from './activity';
import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { readBuildEngine } from './cloudflare';
import { readGithubEngine, configureGithubEngine } from './github';
import { configureBuildEngine } from './setup';
import { readEngineConfiguration, assertEngineConnections, selectionPath, type BuildProvider, type BuildSelection } from './state';
import { CLOUDFLARE_ENGINE_SOURCE } from './setup';
import { GITHUB_ENGINE_SOURCE } from './github-source';

export { selectionPath, type BuildSelection };
export async function readBuildSelection(org: string): Promise<BuildSelection & { auto_update: boolean }> {
  const selection: BuildSelection = await getStore().getDoc<BuildSelection>(selectionPath(org)) ?? { provider: 'cloudflare', revision: 'initial' };
  return { ...selection, auto_update: selection.auto_update === true };
}
export async function selectedBuildProvider(org: string) { return (await readBuildSelection(org)).provider; }
export async function readBuildSettings(org: string) {
  const [selection, cloudflare, github] = await Promise.all([readBuildSelection(org), readBuildEngine(org), readGithubEngine(org)]);
  const engines = { cloudflare, github };
  for (const provider of ['cloudflare', 'github'] as const) {
    const engine = await readEngineConfiguration(org, provider);
    if (engine?.status === 'ready' && (!engine.static_verification || !engine.media_preparation || engine.publication_validation !== 1)) {
      engines[provider] = { ...engines[provider], enabled: false, state: 'setup_required', issue: {
        code: 'build_engine_update_required', message: 'Update the build engine before publishing. Finish build setup to install and verify the required capabilities.',
      } };
    } else if (engine?.status === 'ready' && engine.engine_source_sha256 !== (provider === 'github' ? GITHUB_ENGINE_SOURCE : CLOUDFLARE_ENGINE_SOURCE)) {
      engines[provider] = { ...engines[provider], update_available: true };
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
    if (input.revision !== selection.revision) throw new ConnectionError('Build settings changed. Reload and try again.', 409, 'build_settings_changed');
    const store = getStore();
    await store.createDocIfMissing(selectionPath(org), { provider: selection.provider, revision: selection.revision });
    if (!await store.compareAndUpdateDoc<BuildSelection>(selectionPath(org), value => value.revision === selection.revision, { auto_update: input.enabled, revision: randomUUID() }))
      throw new ConnectionError('Build settings changed. Reload and try again.', 409, 'build_settings_changed');
    return readBuildSettings(org);
  }
  if (input.action === 'select') {
    const selection = await readBuildSelection(org);
    if (input.revision !== selection.revision) throw new ConnectionError('The selected build provider changed. Reload and try again.', 409, 'build_settings_changed');
    const engine = await readEngineConfiguration(org, provider);
    const visible = provider === 'github' ? await readGithubEngine(org) : await readBuildEngine(org);
    if (!engine || engine.status !== 'ready' || !visible.enabled || visible.state !== 'ready') throw new ConnectionError('Finish setup and verification for this build provider before selecting it.', 409, 'build_provider_not_ready');
    await assertEngineConnections(org, engine);
    const store = getStore();
    await store.createDocIfMissing(selectionPath(org), selection);
    if (!await store.compareAndUpdateDoc<BuildSelection>(selectionPath(org), value => value.revision === selection.revision, { provider, revision: randomUUID() })) throw new ConnectionError('The selected build provider changed. Reload and try again.', 409);
  } else if (provider === 'github') await configureGithubEngine(org, input);
  else await configureBuildEngine(org, input);
  return readBuildSettings(org);
}
