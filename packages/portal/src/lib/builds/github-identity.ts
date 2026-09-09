import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { ConnectionError } from '../publishing/connections';
import type { EngineConfiguration } from './state';

const issuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), { timeoutDuration: 10000, cooldownDuration: 30000 });
export const githubClaimAudience = (origin: string, org: string) => `${origin}/api/builds/runner/${org}/claim`;
const denied = () => new ConnectionError('GitHub build identity could not be verified.', 401, 'github_build_identity_invalid');

/** Trust signed immutable IDs and the exact generated workflow, never workflow inputs alone. */
export function assertGithubClaims(claims: JWTPayload, config: EngineConfiguration, audience: string) {
  const github = config.github;
  if (!github) throw denied();
  const repository = `${config.owner}/${github.repo}`, ref = 'refs/heads/main';
  const subjects = [`repo:${repository}:ref:${ref}`, `repo:${config.owner}@${github.owner_id}/${github.repo}@${github.repository_id}:ref:${ref}`];
  const expected = { iss: issuer, aud: audience, repository, repository_id: github.repository_id,
    repository_owner: config.owner, repository_owner_id: github.owner_id, repository_visibility: 'private',
    ref, ref_type: 'branch', event_name: 'workflow_dispatch', runner_environment: 'github-hosted',
    workflow_ref: `${repository}/.github/workflows/build.yml@${ref}`, workflow_sha: config.runner_commit,
    sha: config.runner_commit, run_attempt: '1' };
  if (Object.entries(expected).some(([key, value]) => claims[key] !== value) || !subjects.includes(String(claims.sub)) ||
      !/^\d+$/.test(String(claims.run_id ?? '')) || typeof claims.run_id !== 'string' ||
      typeof claims.actor_id !== 'string' || !/^\d+$/.test(claims.actor_id) ||
      !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.nbf) ||
      claims.exp! - claims.iat! > 600 || claims.exp! <= claims.iat! || typeof claims.jti !== 'string') throw denied();
  return { run_id: claims.run_id, actor_id: claims.actor_id };
}

export async function verifyGithubIdentity(token: string, config: EngineConfiguration, audience: string, getKey: JWTVerifyGetKey = keys) {
  try {
    if (token.length > 16384) throw denied();
    const { payload } = await jwtVerify(token, getKey, { issuer, audience, algorithms: ['RS256'], maxTokenAge: '10m', clockTolerance: 15 });
    return assertGithubClaims(payload, config, audience);
  } catch { throw denied(); }
}
