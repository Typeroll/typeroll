import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { privateJson, publishingJsonBody, connectionFailure } from '../publishing/http';
import { customerBuildMediaAccess } from '../publishing/r2-build-credentials';
import { rateLimit } from '../rate-limit';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from './queue';
import { authorizeEngine, assertEngineConnections, readEngineConfiguration, buildInputPath, engineConfigurationPath, type BuildInput, type EngineConfiguration } from './state';
import { buildStorage } from './storage';
import { decodeSource, decodeArtifact, MAX_SOURCE_BYTES, sha256 } from './contract.mjs';
import { publicationStillRunning } from './jobs';
import { qualificationFiles } from './qualification';
import { enginePath, type BuildEngine } from './cloudflare';
import { authorizeGithubClaim } from './github-claim';

/** These endpoints never use browser cookies or organization API keys. */
export async function runnerRequest(request: Request, org: string, action: string) {
  try {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(org) || !['claim', 'heartbeat', 'upload', 'complete', 'fail'].includes(action)) return privateJson({ error: 'Not found' }, 404);
    const token = request.headers.get('authorization')?.match(/^Bearer ([a-zA-Z0-9_.-]{1,16384})$/)?.[1];
    if (!token) return privateJson({ error: 'Build authentication required.' }, 401);
    const input = await publishingJsonBody(request);
    const queue = new OrganizationBuildQueue(), store = getStore();
    if (action === 'claim') {
      const authorized = input.provider === 'github' ? await authorizeGithubClaim(org, token, input) : null;
      const engine = authorized?.engine ?? await authorizeEngine(org, token, String(input.revision));
      // GitHub applies its authenticated per-run limit before acquiring a lease.
      if (!authorized && !rateLimit(`build-claim:${org}`, 30, 60000).allowed) return privateJson({ error: 'Too many build claims.' }, 429);
      const claim = authorized?.claim ?? await queue.claim(org, engine.revision, Number(input.protocol));
      if (!claim) return privateJson(null);
      const task = await queue.authorize(org, claim.key, claim.lease_id, claim.token);
      const metadata = await store.getDoc<BuildInput>(buildInputPath(org, claim.key));
      if (!metadata || metadata.storage_account_id !== engine.account_id || (metadata.kind === 'publication' && (engine.status !== 'ready' || !await publicationStillRunning(task)))) {
        await queue.cancel(org, claim.key); throw new ConnectionError('This publication is no longer eligible to build.', 409);
      }
      return await buildStorage(org, async storage => {
        if (storage.account !== metadata.storage_account_id) throw new ConnectionError('Build storage changed.', 409);
        let mediaAccess;
        if (metadata.kind === 'publication') {
          const source = decodeSource(await storage.read(metadata.source_key, MAX_SOURCE_BYTES), claim.identity.source_sha256);
          const publication = JSON.parse(source['publication.json']);
          if (publication.media_manifest?.entries?.length || publication.retained_media_manifests?.length)
            mediaAccess = await customerBuildMediaAccess(org, claim.identity.site_id, publication.media_manifest, claim.identity.publication_id, publication.retained_media_manifests);
        }
        return privateJson({ ...claim, kind: metadata.kind, source_url: await storage.grant(metadata.source_key),
          storage_account_id: storage.account,
          ...(mediaAccess ? { media_access: mediaAccess } : {}) });
      });
    }
    const key = String(input.key), lease = String(input.lease_id);
    const task = await queue.authorize(org, key, lease, token);
    const metadata = await store.getDoc<BuildInput>(buildInputPath(org, key));
    const provider = metadata?.provider ?? 'cloudflare';
    const engine = await readEngineConfiguration(org, provider);
    if (!engine || engine.revision !== task.engine_revision || input.revision !== engine.revision || !['ready', 'qualifying'].includes(engine.status)) throw new ConnectionError('The build engine was revoked.', 409);
    await assertEngineConnections(org, engine);
    if (!metadata || (metadata.kind === 'publication' && !await publicationStillRunning(task))) { await queue.cancel(org, key); throw new ConnectionError('Publication cancelled.', 409); }
    if (action === 'heartbeat') { await queue.heartbeat(org, key, lease, token); return privateJson({ ok: true }); }
    if (action === 'upload') return buildStorage(org, async storage => {
      if (storage.account !== metadata.storage_account_id) throw new ConnectionError('Build storage changed.', 409);
      await queue.heartbeat(org, key, lease, token);
      return privateJson({ artifact_url: await storage.grant(`builds/${org}/tasks/${key}/${lease}/artifact.json`, true) });
    });
    if (action === 'fail') {
      const code = typeof input.code === 'string' && /^[a-z0-9_]{1,80}$/.test(input.code) ? input.code : 'shared_build_failed';
      const stage = typeof input.stage === 'string' && /^[a-z_]{1,30}$/.test(input.stage) ? input.stage : 'build';
      await store.compareAndUpdateDoc<BuildTask>(`${buildTasksPath(org)}/${key}`, value => value.status === 'running' && value.lease_id === lease && value.token_hash === task.token_hash && value.lease_until > Date.now() && value.deadline > Date.now(),
        { status: 'failed', token_hash: null, error_code: `${stage}_${code}`, lease_until: 0 });
      if (metadata.kind === 'qualification') {
        const disabled = await store.compareAndUpdateDoc<EngineConfiguration>(engineConfigurationPath(org, provider), value => value.revision === engine.revision && value.status === 'qualifying', { status: 'disabled' });
        if (disabled) await store.updateDoc(enginePath(org, provider), { state: 'error', enabled: false, issue: { code: 'build_qualification_failed', message: `Build verification failed during ${stage} (${code}). Set up the shared engine again to retry.` } });
      }
      return privateJson({ ok: true });
    }
    const artifactKey = `builds/${org}/tasks/${key}/${lease}/artifact.json`;
    await buildStorage(org, async storage => {
      if (storage.account !== metadata.storage_account_id) throw new ConnectionError('Build storage changed.', 409);
      const files = decodeArtifact(await storage.read(artifactKey), task.identity, String(input.sha256));
      if (metadata.kind === 'qualification') {
        const expected = qualificationFiles(task.identity.publication_id);
        if (key !== engine.qualification_key || Object.keys(files).length !== Object.keys(expected).length || Object.entries(expected).some(([name, value]) => sha256(files[name] ?? Buffer.alloc(0)) !== sha256(value)))
          throw new ConnectionError('Build verification returned a different artifact.', 409);
      }
    });
    await queue.complete(org, key, lease, token, { sha256: String(input.sha256), key: artifactKey });
    if (metadata.kind === 'qualification') {
      const activated = await store.compareAndUpdateDoc<EngineConfiguration>(engineConfigurationPath(org, provider), value => value.revision === engine.revision && value.status === 'qualifying', { status: 'ready' });
      if (activated) await store.updateDoc(enginePath(org, provider), { revision: randomUUID(), state: 'ready', enabled: true, checked_at: new Date().toISOString(),
        issue: null } satisfies Partial<BuildEngine>);
    }
    return privateJson({ ok: true });
  } catch (error) { return connectionFailure(error); }
}
