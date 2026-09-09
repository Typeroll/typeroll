import { expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { assertGithubClaims, verifyGithubIdentity } from '../../lib/builds/github-identity';
import { assertGithubRun, dispatchGithubBuild, readGithubDispatch } from '../../lib/builds/github';
import type { EngineConfiguration } from '../../lib/builds/state';
import { githubBuildFiles } from '../../lib/builds/github-source';
import { ProviderError } from '../../lib/publishing/providers.mjs';

const config: EngineConfiguration = { provider: 'github', revision: 'revision-a', account_id: 'a'.repeat(32), owner: 'Example-Org', installation_id: '91',
  worker_tag: '', trigger_uuid: '', runner_commit: 'c'.repeat(40), token_hash: '', encrypted_token: '', status: 'ready', setup_lease_until: 0,
  github: { repository_id: '31', owner_id: '17', repo: 'typeroll-builder-test', app_bot: 'publisher-test[bot]', workflow_id: 88 } };
const audience = 'https://cms.example.invalid/api/builds/runner/org/claim';
const payload = () => { const now = Math.floor(Date.now() / 1000); return {
  iss: 'https://token.actions.githubusercontent.com', aud: audience, sub: 'repo:Example-Org@17/typeroll-builder-test@31:ref:refs/heads/main',
  repository: 'Example-Org/typeroll-builder-test', repository_id: '31', repository_owner: 'Example-Org', repository_owner_id: '17', repository_visibility: 'private',
  ref: 'refs/heads/main', ref_type: 'branch', event_name: 'workflow_dispatch', runner_environment: 'github-hosted',
  workflow_ref: 'Example-Org/typeroll-builder-test/.github/workflows/build.yml@refs/heads/main', workflow_sha: 'c'.repeat(40), sha: 'c'.repeat(40),
  run_id: '271', run_attempt: '1', actor_id: '42', iat: now, nbf: now, exp: now + 300, jti: 'unique-synthetic-token',
}; };
it('verifies real signatures and both supported subject formats while retaining immutable identity checks', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const claims = payload();
  const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'synthetic' }).sign(privateKey);
  expect(await verifyGithubIdentity(token, config, audience, async () => publicKey)).toEqual({ run_id: '271', actor_id: '42' });
  expect(assertGithubClaims({ ...claims, sub: 'repo:Example-Org/typeroll-builder-test:ref:refs/heads/main' }, config, audience)).toMatchObject({ run_id: '271' });
  const foreign = await generateKeyPair('RS256');
  await expect(verifyGithubIdentity(token, config, audience, async () => foreign.publicKey)).rejects.toMatchObject({ status: 401 });
  const expired = await new SignJWT({ ...claims, iat: claims.iat - 700, nbf: claims.nbf - 700, exp: claims.exp - 700 }).setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
  await expect(verifyGithubIdentity(expired, config, audience, async () => publicKey)).rejects.toMatchObject({ status: 401 });
  await expect(verifyGithubIdentity(token, config, audience + '/other', async () => publicKey)).rejects.toMatchObject({ status: 401 });
});
it('rejects another repository, organization, workflow, branch, run attempt, host or token scope', () => {
  for (const changed of [
    { repository_id: '32' }, { repository_owner_id: '18' }, { repository: 'Example-Org/other' }, { ref: 'refs/heads/version-blue' },
    { workflow_ref: 'Example-Org/typeroll-builder-test/.github/workflows/untrusted.yml@refs/heads/main' },
    { workflow_sha: 'd'.repeat(40) }, { sha: 'e'.repeat(40) }, { run_attempt: '2' }, { event_name: 'push' },
    { sub: 'repo:Example-Org/typeroll-builder-test:pull_request' }, { runner_environment: 'self-hosted' }, { repository_visibility: 'public' },
    { aud: [audience] }, { exp: payload().iat + 3600 }, { nbf: undefined }, { run_id: 271 },
  ]) expect(() => assertGithubClaims({ ...payload(), ...changed }, config, audience)).toThrow('identity');
});
const nonce = '11111111-1111-4111-8111-111111111111';
const run = () => ({ id: 271, repository: { id: 31, owner: { id: 17 } }, path: '.github/workflows/build.yml', event: 'workflow_dispatch',
  head_sha: 'c'.repeat(40), head_branch: 'main', run_attempt: 1, actor: { id: 42, login: 'publisher-test[bot]' }, triggering_actor: { id: 42 }, display_title: `Typeroll build ${nonce}` });
it('binds provider metadata to the App dispatch, rejecting manual reruns and swapped task nonces', () => {
  expect(() => assertGithubRun(run(), config, nonce, '271')).not.toThrow();
  for (const changed of [{ id: 272 }, { actor: { id: 99, login: 'manual-user' }, triggering_actor: { id: 99 } }, { triggering_actor: { id: 99 } }, { run_attempt: 2 }, { display_title: 'Typeroll build foreign' }, { head_sha: 'd'.repeat(40) }])
    expect(() => assertGithubRun({ ...run(), ...changed }, config, nonce, '271')).toThrow('attempt');
});
it('dispatches only an active unchanged runner and recovers a lost response by its unique nonce', async () => {
  const client = vi.fn(async (route: string) => route.includes('/git/ref/') ? { object: { sha: config.runner_commit } } : route.endsWith('/dispatches') ? { workflow_run_id: 271 } : { id: 88, state: 'active', path: '.github/workflows/build.yml' });
  expect(await dispatchGithubBuild(client, config, 'f'.repeat(64), nonce)).toBe('271');
  expect(client.mock.calls[2]).toEqual(['/repos/Example-Org/typeroll-builder-test/actions/workflows/88/dispatches', { method: 'POST', body: { ref: 'main', inputs: { task_key: 'f'.repeat(64), dispatch_nonce: nonce } } }]);
  client.mockImplementation(async () => ({ object: { sha: 'd'.repeat(40) } }) as any);
  await expect(dispatchGithubBuild(client, config, 'f'.repeat(64), nonce)).rejects.toMatchObject({ code: 'github_runner_changed' });
  const recovered = vi.fn(async (route: string) => route.includes('?event=') ? { workflow_runs: [run()] } : run());
  expect((await readGithubDispatch(recovered, config, { source_key: 'source', kind: 'qualification', storage_account_id: config.account_id, dispatch_nonce: nonce, dispatch_uncertain: true })).id).toBe(271);
});
it('generates only explicit, credential-free workflows with a separate trusted host bootstrap', () => {
  const files = githubBuildFiles('https://cms.example.invalid', 'org', 'revision');
  const workflow = files['.github/workflows/build.yml'];
  expect(workflow).toContain('id-token: write'); expect(workflow).toContain('persist-credentials: false');
  expect(workflow).not.toMatch(/\b(push|pull_request|schedule):|secrets\.|sysctl|sudo[^\n]*github-runner/);
  expect(workflow).toContain('run: node github-runner.mjs');
  expect(Object.keys(files)).not.toContain('publication.json');
  expect(JSON.parse(files['engine.json'])).toEqual({ origin: 'https://cms.example.invalid', org_id: 'org', revision: 'revision' });
});
it('reports definite provider rejection while preserving uncertainty after a transport failure', async () => {
  for (const status of [403, 422, 429, 500, 408]) {
    const client = vi.fn(async (route: string) => {
      if (route.endsWith('/dispatches')) throw new ProviderError('GitHub', status);
      return route.includes('/git/ref/') ? { object: { sha: config.runner_commit } } : { id: 88, state: 'active', path: '.github/workflows/build.yml' };
    });
    const result = dispatchGithubBuild(client, config, 'f'.repeat(64), nonce);
    if (status < 500 && status !== 408) await expect(result).rejects.toMatchObject({ code: 'github_dispatch_rejected' });
    else await expect(result).rejects.toBeInstanceOf(ProviderError);
  }
});
