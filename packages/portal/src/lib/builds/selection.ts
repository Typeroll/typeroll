import { activeBuilds, cancelGithubTask } from './activity';
import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { readBuildEngine } from './cloudflare';
import { readGithubEngine, configureGithubEngine } from './github';
import { configureBuildEngine } from './setup';
import { readEngineConfiguration, assertEngineConnections, type BuildProvider } from './state';

export const selectionPath = (org: string) => `organizations/${org}/publishing/build_selection`;
export interface BuildSelection { provider: BuildProvider; revision: string }
export async function readBuildSelection(org: string): Promise<BuildSelection> {
  return await getStore().getDoc<BuildSelection>(selectionPath(org)) ?? { provider: 'cloudflare', revision: 'initial' };
}
export async function selectedBuildProvider(org: string) { return (await readBuildSelection(org)).provider; }
export async function readBuildSettings(org: string) {
  const [selection, cloudflare, github] = await Promise.all([readBuildSelection(org), readBuildEngine(org), readGithubEngine(org)]);
  const engines = { cloudflare, github };
  // Keep the existing top-level selected-engine fields for older API clients.
  return { ...engines[selection.provider], selection, engines, active_jobs: await activeBuilds(org) };
}
export async function configureBuildSettings(org: string, input: Record<string, unknown>) {
  if (input.provider !== undefined && input.provider !== 'cloudflare' && input.provider !== 'github') throw new ConnectionError('Choose Cloudflare or GitHub.', 400);
  const provider: BuildProvider = input.provider as BuildProvider ?? 'cloudflare';
  if (input.action === 'cancel') {
    await cancelGithubTask(org, String(input.key));
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
