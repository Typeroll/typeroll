import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { type ProviderClient } from '../publishing/providers.mjs';
import { buildStorage } from './storage';
import { sha256 } from './contract.mjs';
import { staticChecks, verifyStaticResponse, type StaticCheck, type StaticObservation } from './verification';

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

export async function saveStaticChecks(org: string, files: Record<string, Buffer>, previousKey?: string) {
  return buildStorage(org, async storage => {
    const previous = previousKey ? JSON.parse((await storage.read(previousKey, 32 * 1024 * 1024)).toString('utf8')) as StaticCheck[] : [];
    const bytes = Buffer.from(JSON.stringify(staticChecks(files, previous)));
    const key = `builds/${org}/checks/${sha256(bytes)}.json`;
    await storage.put(key, bytes); return key;
  });
}

/** Durable, bounded checks let the normal publication queue wait for public distribution. */
export async function verifyStaticBatch(org: string, jobPath: string, checksKey: string, origin: string) {
  const store = getStore(), checkPath = `${jobPath}/build_verifications/${sha256(`${checksKey}\0${origin}`)}`;
  const state = await store.getDoc<{ cursor: number; complete: boolean }>(checkPath);
  if (state?.complete) return true;
  const checks = await buildStorage(org, async storage => JSON.parse((await storage.read(checksKey, 32 * 1024 * 1024)).toString('utf8')) as StaticCheck[]);
  if (!Array.isArray(checks) || !checks.length) throw new ConnectionError('Static verification data is missing.', 409);
  let cursor = state?.cursor ?? 0;
  const limit = Math.min(checks.length, cursor + 64), deadline = Date.now() + 20000;
  // Healthy small sites finish in one observation instead of waiting a queue
  // backoff for every eight files. Concurrency, work and elapsed time stay bounded.
  do {
    const batch = checks.slice(cursor, Math.min(cursor + 8, limit));
    const observations: StaticObservation[] = [];
    const results = await Promise.all(batch.map(check => verifyStaticResponse(origin, check, { observe: result => { observations.push(result); } })));
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
    if (complete) { await store.updateDoc(jobPath, { verification_message: null, static_probe: null }); return true; }
  } while (cursor < limit && Date.now() < deadline);
  return false;
}
