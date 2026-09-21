import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { type ProviderClient } from '../publishing/providers.mjs';
import { buildStorage } from './storage';
import { sha256 } from './contract.mjs';
import type { DirectReceipt } from './direct-upload.mjs';
import { staticManifestChecks, staticChecks, verifyStaticResponse, type StaticCheck, type StaticObservation } from './verification';
import { staticControlsHash, changedStaticChecks, selectStaticProbes, publicStaticChecks, needsMediaRetentionEvidence, PROBE_FILE_BYTES, PROBE_BYTES, PROBE_FILES } from './static-verifier.mjs';
import { enqueueBuild, completedBuild } from './jobs';
import { readEngineConfiguration, type BuildProvider } from './state';
import { buildTasksPath, type BuildTask } from './queue';

export interface CustomerVerification {
  account_id: string; project: string; website_host: string; domain_revision: string;
  static_checks_key?: string | null; static_controls_sha256?: string | null;
  verification_checks_key?: string | null; probe_checks_key?: string | null;
  verification_task_key?: string | null; build_task_key?: string | null; build_provider?: BuildProvider;
}

export async function saveCustomerVerification(org: string, current: CustomerVerification, direct: DirectReceipt, previous?: CustomerVerification) {
  const controls = staticControlsHash(direct.controls);
  return buildStorage(org, async storage => {
    const checks = JSON.parse((await storage.read(current.static_checks_key!, 32 * 1024 * 1024)).toString('utf8')) as StaticCheck[];
    const old = previous?.static_checks_key ? JSON.parse((await storage.read(previous.static_checks_key, 32 * 1024 * 1024)).toString('utf8')) as StaticCheck[] : [];
    const reuse = !!previous && previous.static_controls_sha256 === controls &&
      ['account_id', 'project', 'website_host', 'domain_revision'].every(key => current[key as keyof CustomerVerification] === previous[key as keyof CustomerVerification]);
    const changed = changedStaticChecks(checks, old, reuse);
    const probes = selectStaticProbes(checks, changed);
    if (!probes.some(check => check.route === '/.well-known/typeroll/publication.json')) throw new ConnectionError('The publication marker exceeds the coordinator probe budget.', 409);
    const save = async (value: StaticCheck[]) => {
      const bytes = Buffer.from(JSON.stringify(value)), key = `builds/${org}/checks/${sha256(bytes)}.json`;
      await storage.put(key, bytes); return key;
    };
    return { static_controls_sha256: controls, verification_checks_key: await save(changed), probe_checks_key: await save(probes) };
  });
}

/** The customer engine owns exhaustive candidate checks; the coordinator consumes only its receipt. */
export async function verifyCustomerCandidate(org: string, jobPath: string, current: CustomerVerification, origin: string) {
  const store = getStore(), task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${current.build_task_key}`);
  const config = await readEngineConfiguration(org, current.build_provider);
  if (!task || !config || config.revision !== task.engine_revision || !config.static_verification) throw new ConnectionError('Update the build engine in Publishing → Builds before publishing.', 409, 'build_engine_update_required');
  let key = current.verification_task_key;
  if (!key) {
    const checks = await buildStorage(org, async storage => JSON.parse((await storage.read(current.verification_checks_key!, 32 * 1024 * 1024)).toString('utf8')));
    const queued = await enqueueBuild(config, task.identity, { 'verification.json': JSON.stringify({ publication_id: task.identity.publication_id, origin, checks }) }, 'static_verification');
    key = queued.key; current.verification_task_key = key;
    await store.updateDoc(jobPath, { git_publication: current });
  }
  return !!await completedBuild(org, key);
}

export async function prepareStaticProject(client: ProviderClient, root: string, expected: { project: string; owner: string; repo: string; repository: any; requireExisting?: boolean }) {
  let project = await client(root, { missing: true });
  if (!project && expected.requireExisting) throw new ConnectionError('The migrated Pages project is unavailable. Restore access to the existing project before publishing.', 409, 'managed_project_missing');
  if (!project) { await client(root.slice(0, root.lastIndexOf('/')), { method: 'POST', body: { name: expected.project, production_branch: 'main' } }); project = await client(root); }
  if (project.name !== expected.project || project.production_branch !== 'main') throw new ConnectionError('The static hosting project does not match this site.', 409);
  if (project.source) {
    if (project.source.type !== 'github' || String(project.source.config?.repo_id) !== String(expected.repository.id) || project.source.config?.owner !== expected.owner || project.source.config?.repo_name !== expected.repo)
      throw new ConnectionError('Cloudflare is connected to a different source repository.', 409);
    if (project.source.config.production_deployments_enabled !== false || project.source.config.preview_deployment_setting !== 'none') {
      await client(root, { method: 'PATCH', body: { source: { type: 'github', config: { production_deployments_enabled: false, preview_deployment_setting: 'none' } } } });
      project = await client(root);
      if (project.source?.config?.production_deployments_enabled !== false || project.source?.config?.preview_deployment_setting !== 'none') throw new ConnectionError('Disable automatic Pages builds before using the shared engine.', 409);
    }
  }
  return project;
}

export async function saveStaticChecks(org: string, files: Record<string, Buffer>, previousKey?: string, direct?: DirectReceipt | null) {
  return buildStorage(org, async storage => {
    const previous = previousKey ? JSON.parse((await storage.read(previousKey, 32 * 1024 * 1024)).toString('utf8')) as StaticCheck[] : [];
    const bytes = Buffer.from(JSON.stringify(direct ? staticManifestChecks(direct.files, Buffer.from(direct.controls._redirects ?? '', 'base64').toString('utf8'), previous) : staticChecks(files, previous)));
    const key = `builds/${org}/checks/${sha256(bytes)}.json`;
    await storage.put(key, bytes); return key;
  });
}

/** Durable, bounded checks let the normal publication queue wait for public distribution. */
export async function verifyStaticBatch(org: string, jobPath: string, checksKey: string, origin: string, bounded = false) {
  const store = getStore(), checkPath = `${jobPath}/build_verifications/${sha256(`${checksKey}\0${origin}\0public-v3`)}`;
  const state = await store.getDoc<{ cursor: number; complete: boolean }>(checkPath);
  if (state?.complete) return true;
  const savedChecks = await buildStorage(org, async storage => JSON.parse((await storage.read(checksKey, 32 * 1024 * 1024)).toString('utf8')) as StaticCheck[]);
  // Apply the policy at consumption too so in-flight publications with older
  // persisted probe lists can recover through the normal coordinator.
  let currentChecks = savedChecks;
  if (bounded && Array.isArray(savedChecks) && needsMediaRetentionEvidence(savedChecks)) {
    const job = await store.getDoc<{ git_publication?: { static_checks_key?: string } }>(jobPath);
    const fullKey = job?.git_publication?.static_checks_key;
    if (fullKey && fullKey !== checksKey) {
      currentChecks = await buildStorage(org, async storage => JSON.parse((await storage.read(fullKey, 32 * 1024 * 1024)).toString('utf8')) as StaticCheck[]);
      if (!Array.isArray(currentChecks)) throw new ConnectionError('Static verification data is missing.', 409);
    }
  }
  const checks = Array.isArray(savedChecks) ? publicStaticChecks(savedChecks, currentChecks) as StaticCheck[] : savedChecks;
  if (!Array.isArray(checks) || !checks.length) throw new ConnectionError('Static verification data is missing.', 409);
  if (bounded && checks.length > PROBE_FILES) throw new ConnectionError('Coordinator probe count exceeds its limit.', 409);
  let downloaded = 0;
  const observeBytes = bounded ? (bytes: number) => { downloaded += bytes; if (downloaded > PROBE_BYTES) throw Error('coordinator_probe_byte_limit'); } : undefined;
  let cursor = state?.cursor ?? 0;
  const limit = Math.min(checks.length, cursor + 1024), deadline = Date.now() + 20000;
  // Image libraries produce thousands of static files. Drain healthy checks
  // within the same time budget instead of paying queue backoff every 64 files.
  do {
    const batch = checks.slice(cursor, Math.min(cursor + 8, limit));
    const observations: StaticObservation[] = [];
    const results = await Promise.all(batch.map(check => verifyStaticResponse(origin, check, { maxBytes: bounded ? PROBE_FILE_BYTES : undefined, observeBytes, observe: result => { observations.push(result); } })));
    if (!results.every(Boolean)) {
      const failure = observations.sort((a, b) => a.route.localeCompare(b.route))[0];
      await store.setDoc(checkPath, { cursor: 0, complete: false, failure: failure ?? null });
      if (failure) await store.updateDoc(jobPath, {
        static_probe: { origin, ...failure, checked_at: new Date().toISOString() },
        verification_message: failure.reason === 'status_mismatch'
          ? `The hosting service still returns HTTP ${failure.actual_status} at ${failure.route}; this deployment requires HTTP ${failure.expected_status}. Public verification will retry automatically.`
          : failure.reason === 'content_mismatch'
          ? `The hosting service returns different content at ${failure.route}. Public verification will retry automatically.`
          : `The hosting service could not be verified at ${failure.route}. Public verification will retry automatically.`,
      });
      return false;
    }
    cursor += batch.length;
    const complete = cursor >= checks.length;
    await store.setDoc(checkPath, { cursor, complete });
    if (complete) { if (bounded) console.info(JSON.stringify({ event: 'coordinator_static_probes', files: checks.length, downloaded_bytes: downloaded })); await store.updateDoc(jobPath, { verification_message: null, static_probe: null }); return true; }
  } while (cursor < limit && Date.now() < deadline);
  return false;
}
