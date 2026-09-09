import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { rateLimit } from '../rate-limit';
import { readEngineConfiguration, assertEngineConnections, buildInputPath, type BuildInput } from './state';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from './queue';
import { githubClaimAudience, verifyGithubIdentity } from './github-identity';
import { githubBuildClient, githubBuildRoot, assertGithubRun } from './github';

export async function authorizeGithubClaim(org: string, token: string, input: Record<string, unknown>) {
  const key = String(input.key), nonce = String(input.dispatch_nonce);
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9-]{36}$/.test(nonce)) throw new ConnectionError('Invalid GitHub build dispatch.', 401);
  const engine = await readEngineConfiguration(org, 'github');
  if (!engine?.github || !['ready', 'qualifying'].includes(engine.status) || engine.revision !== input.revision) throw new ConnectionError('The GitHub build engine changed.', 409);
  const origin = new URL(process.env.PORTAL_PUBLIC_URL ?? '').origin;
  const claims = await verifyGithubIdentity(token, engine, githubClaimAudience(origin, org));
  if (!rateLimit(`github-build-claim:${org}:${claims.run_id}`, 10, 60000).allowed) throw new ConnectionError('Too many build claims.', 429);
  await assertEngineConnections(org, engine);
  const store = getStore(), path = buildInputPath(org, key);
  const metadata = await store.getDoc<BuildInput>(path), task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  if (metadata?.provider !== 'github' || metadata.dispatch_nonce !== nonce || !task || task.engine_revision !== engine.revision ||
      (metadata.dispatch_id && metadata.dispatch_id !== claims.run_id) || (!metadata.dispatch_id && !metadata.dispatch_uncertain)) throw new ConnectionError('This GitHub run was not dispatched for this task.', 409, 'github_build_run_mismatch');
  const client = await githubBuildClient(engine);
  const run = await client(`${githubBuildRoot(engine)}/actions/runs/${claims.run_id}`);
  assertGithubRun(run, engine, nonce, claims.run_id);
  if (String(run.actor.id) !== claims.actor_id || run.status !== 'in_progress') throw new ConnectionError('The GitHub build is no longer running.', 409);
  // Recover an accepted dispatch even if the API response was lost. A guessed input
  // cannot bind a different run: signed claims and provider metadata must both match.
  const bound = await store.compareAndUpdateDoc<BuildInput>(path, value => value.dispatch_nonce === nonce &&
    ((!value.dispatch_id && value.dispatch_uncertain === true) || value.dispatch_id === claims.run_id),
    { dispatch_id: claims.run_id, dispatch_uncertain: false });
  if (!bound) throw new ConnectionError('The GitHub build attempt changed.', 409);
  const claim = await new OrganizationBuildQueue().claim(org, engine.revision, Number(input.protocol), { key, dispatch_id: claims.run_id });
  if (!claim) throw new ConnectionError('This build was already claimed, cancelled or expired.', 409, 'build_lease_lost');
  return { engine, claim };
}
