import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { readBuildEngine } from './cloudflare';
import { readGithubEngine, configureGithubEngine } from './github';
import { GITHUB_ENGINE_SOURCE } from './github-source';
import { buildTasksPath, type BuildTask } from './queue';
import { readBuildSelection } from './selection';
import { configureBuildEngine, CLOUDFLARE_ENGINE_SOURCE } from './setup';
import { readEngineConfiguration, type BuildProvider, type EngineConfiguration } from './state';
import { engineUpdateFixes } from './failure-message';
import type { BuildDiagnostic } from './diagnostics.mjs';

/** How long a publication waits for other builds before it updates the engine after a known failure. */
export const ENGINE_UPDATE_WAIT_MS = 30 * 60_000;

/**
 * What a publication recorded about updating the engine on its own behalf.
 * reason: an update was available, or a build failed in a way a current engine fixes.
 */
export interface EngineUpdateRecord {
  reason: 'update_available' | 'known_failure';
  state: 'waiting_for_builds' | 'started' | 'updated' | 'kept' | 'skipped';
  from_revision: string; to_revision?: string; requested_at: number;
  message?: string; failure_code?: string | null; failure?: string;
}

export type EngineStep =
  | { state: 'waiting'; phase: string; record: EngineUpdateRecord }
  | { state: 'ready'; engine: EngineConfiguration; record?: EngineUpdateRecord; warning?: string };

/** The engine runs an older generated source than this Core, or lacks a required capability. */
export function engineOutdated(config: EngineConfiguration | null | undefined): boolean {
  if (!config || config.status !== 'ready') return false;
  const source = (config.provider ?? 'cloudflare') === 'github' ? GITHUB_ENGINE_SOURCE : CLOUDFLARE_ENGINE_SOURCE;
  return config.engine_source_sha256 !== source || !config.static_verification || !config.media_preparation || config.publication_validation !== 1;
}

async function otherBuildsActive(org: string) {
  const active = await getStore().listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 1 });
  return active.length > 0;
}

/** The provider's own setup, run as an admin would from Publishing → Builds. */
async function engineSetup(org: string, provider: BuildProvider, action: 'setup' | 'check') {
  if (provider === 'github') return configureGithubEngine(org, { action, revision: (await readGithubEngine(org)).revision });
  return configureBuildEngine(org, action === 'setup' ? { action, revision: (await readBuildEngine(org)).revision } : { action });
}
const readEngine = (org: string, provider: BuildProvider) => provider === 'github' ? readGithubEngine(org) : readBuildEngine(org);

/** May this failed build be retried once on an updated engine? */
export async function engineUpdateRetryAllowed(org: string, provider: BuildProvider, code: string | null | undefined, diagnostic?: BuildDiagnostic | null) {
  if (!engineUpdateFixes(code, diagnostic)) return false;
  const [selection, config] = await Promise.all([readBuildSelection(org), readEngineConfiguration(org, provider)]);
  return selection.auto_update && engineOutdated(config);
}

/**
 * Called by a publication immediately before it enqueues its build, never
 * while a build of its own is running. With auto_update on, an outdated
 * engine (Cloudflare or GitHub) is updated first and its verification awaited; if the
 * update fails the previous engine is restored and the build continues on it.
 * Without auto_update this returns the current engine unchanged.
 */
export async function prepareEngineForBuild(org: string, provider: BuildProvider, record: EngineUpdateRecord | undefined, now = Date.now()): Promise<EngineStep> {
  let config = await readEngineConfiguration(org, provider);
  if (!config) throw new ConnectionError('Finish shared build setup in Publishing → Builds before deploying.', 409, 'shared_build_setup_required');
  if (config.status === 'preparing' || config.status === 'qualifying') {
    // This publication, another one or an admin is updating the engine: wait for its verification.
    const started: EngineUpdateRecord = record?.state === 'started' ? record
      : { ...record, reason: record?.reason ?? 'update_available', state: 'started', from_revision: config.previous?.revision ?? record?.from_revision ?? '', requested_at: record?.requested_at ?? now };
    if (config.status === 'qualifying') {
      // Drives a stalled verification: redispatches it, or fails it and restores the previous engine.
      await engineSetup(org, provider, 'check').catch(error => { if (!(error instanceof ConnectionError)) throw error; });
      config = (await readEngineConfiguration(org, provider))!;
    }
    if (config.status === 'preparing' || config.status === 'qualifying') return { state: 'waiting', phase: 'updating the build engine: verifying the new engine', record: started };
    record = started;
  }
  if (record?.state === 'started') {
    if (config.status !== 'ready') {
      const engine = await readEngine(org, provider);
      throw new ConnectionError(`The build engine update did not finish and the previous engine could not be restored: ${engine.issue?.message ?? 'check Publishing → Builds'} The live site is unchanged.`, 409, engine.issue?.code ?? 'build_engine_update_failed');
    }
    if (config.revision === record.from_revision) {
      const engine = await readEngine(org, provider);
      const message = engine.issue?.message ?? 'The build engine update did not take effect; the previous engine is still in use.';
      return { state: 'ready', engine: config, record: { ...record, state: 'kept', message }, warning: message };
    }
    return { state: 'ready', engine: config, record: { ...record, state: 'updated', to_revision: config.revision } };
  }
  if (record && record.state !== 'waiting_for_builds') return { state: 'ready', engine: config };
  if (config.status !== 'ready') throw new ConnectionError('Finish shared build setup in Publishing → Builds before deploying.', 409, 'shared_build_setup_required');
  const selection = await readBuildSelection(org);
  if (!engineOutdated(config) || !selection.auto_update) return { state: 'ready', engine: config };
  const reason = record?.reason ?? 'update_available';
  const base: EngineUpdateRecord = { ...record, reason, from_revision: config.revision, requested_at: record?.requested_at ?? now, state: 'waiting_for_builds' };
  if (await otherBuildsActive(org)) {
    // An available update can wait for a later publication; a known failure cannot be retried on the old engine.
    if (reason === 'update_available') return { state: 'ready', engine: config, record: { ...base, state: 'skipped', message: 'Other builds were running; the engine update waits for a later publication.' } };
    if (now - base.requested_at > ENGINE_UPDATE_WAIT_MS) throw new ConnectionError(`${record?.failure ?? 'The build failed.'} Other builds kept the build engine busy for 30 minutes, so it could not be updated. Retry publishing when they finish.`, 409, record?.failure_code ?? 'build_engine_update_waiting');
    return { state: 'waiting', phase: 'waiting for other builds before updating the build engine', record: base };
  }
  try {
    await engineSetup(org, provider, 'setup');
  } catch (error) {
    if (!(error instanceof ConnectionError) || error.status !== 409) throw error;
    // Another publication or an admin started the same update: wait for it.
  }
  console.info(JSON.stringify({ event: 'build_engine_auto_update', org_id: org, provider, reason, from_revision: config.revision }));
  return { state: 'waiting', phase: 'updating the build engine', record: { ...base, state: 'started' } };
}
