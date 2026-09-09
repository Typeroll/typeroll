import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { OrganizationBuildQueue, buildTasksPath } from '../../lib/builds/queue';
import { authorizeGithubClaim } from '../../lib/builds/github-claim';
import { verifyGithubIdentity } from '../../lib/builds/github-identity';
import { githubBuildClient } from '../../lib/builds/github';
import { cancelGithubTask } from '../../lib/builds/activity';
import { engineConfigurationPath, buildInputPath, type EngineConfiguration } from '../../lib/builds/state';
import { enginePath } from '../../lib/builds/cloudflare';
import { connectionPath } from '../../lib/publishing/connections';
import { BUILD_RUNTIME, type BuildIdentity } from '../../lib/builds/contract.mjs';
vi.mock('../../lib/builds/github-identity', async original => ({ ...await original<object>(), verifyGithubIdentity: vi.fn() }));
vi.mock('../../lib/builds/github', async original => ({ ...await original<object>(), githubBuildClient: vi.fn() }));
const config: EngineConfiguration = { provider: 'github', revision: 'gh-revision', account_id: 'a'.repeat(32), owner: 'Example-Org', installation_id: '91',
  worker_tag: '', trigger_uuid: '', runner_commit: 'c'.repeat(40), token_hash: '', encrypted_token: '', status: 'qualifying', setup_lease_until: 0,
  github: { repository_id: '31', owner_id: '17', repo: 'typeroll-builder-test', app_bot: 'publisher-test[bot]', workflow_id: 88 } };
const nonce = '11111111-1111-4111-8111-111111111111';
const identity: BuildIdentity = { protocol: 1, node_version: BUILD_RUNTIME, org_id: 'org', site_id: 'site', version_id: 'redesign', job_id: 'job', publication_id: 'a'.repeat(64), source_sha256: 'b'.repeat(64), commit: 'd'.repeat(40), branch: 'version-redesign' };
let key: string;
let run: any;
const client = vi.fn();
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.resetAllMocks(); vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.invalid');
  await getStore().setDoc(connectionPath('org', 'github'), { status: 'connected', revision: 'connection-git', github: { owner: 'Example-Org', installation_id: '91', account_id: '17' } });
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'connection-cf', cloudflare: { account_id: config.account_id } });
  await getStore().setDoc(engineConfigurationPath('org', 'github'), config);
  await getStore().setDoc(enginePath('org', 'github'), { revision: 'view', state: 'qualification_required' });
  key = (await new OrganizationBuildQueue().enqueue(identity, config.revision)).key;
  await getStore().setDoc(buildInputPath('org', key), { provider: 'github', kind: 'qualification', source_key: 'source', storage_account_id: config.account_id, dispatch_nonce: nonce, dispatch_uncertain: true });
  run = { id: 271, repository: { id: 31, owner: { id: 17 } }, path: '.github/workflows/build.yml', event: 'workflow_dispatch', head_sha: config.runner_commit,
    head_branch: 'main', run_attempt: 1, actor: { id: 42, login: 'publisher-test[bot]' }, triggering_actor: { id: 42 }, display_title: `Typeroll build ${nonce}`, status: 'in_progress' };
  vi.mocked(verifyGithubIdentity).mockResolvedValue({ run_id: '271', actor_id: '42' });
  client.mockImplementation(async () => run); vi.mocked(githubBuildClient).mockResolvedValue(client);
});
afterEach(() => { vi.unstubAllEnvs(); });
const claim = (changes = {}) => authorizeGithubClaim('org', 'synthetic-signed-identity', { revision: config.revision, key, dispatch_nonce: nonce, protocol: 1, ...changes });
it('recovers a lost dispatch response using signed run identity and issues one attempt for the frozen branch', async () => {
  const result = await claim();
  expect(result.claim.identity).toEqual(identity);
  expect(result.claim.identity.commit).not.toBe(config.runner_commit);
  expect(await getStore().getDoc(buildInputPath('org', key))).toMatchObject({ dispatch_id: '271', dispatch_uncertain: false });
  await expect(claim()).rejects.toMatchObject({ code: 'build_lease_lost' });
  expect((await getStore().getDoc<any>(`${buildTasksPath('org')}/${key}`)).attempt).toBe(1);
});
it('rejects a foreign task nonce or signed run before it can claim source', async () => {
  await expect(claim({ dispatch_nonce: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ code: 'github_build_run_mismatch' });
  expect(client).not.toHaveBeenCalled();
  await getStore().updateDoc(buildInputPath('org', key), { dispatch_id: '999' });
  await expect(claim()).rejects.toMatchObject({ code: 'github_build_run_mismatch' });
  expect(client).not.toHaveBeenCalled();
  expect(await getStore().getDoc(`${buildTasksPath('org')}/${key}`)).toMatchObject({ status: 'queued', attempt: 0 });
});
it('does not authorize a manual dispatch, stopped run, changed engine or disconnected organization', async () => {
  run.actor.login = 'manual-user';
  await expect(claim()).rejects.toMatchObject({ code: 'github_build_run_mismatch' });
  run.actor.login = 'publisher-test[bot]'; run.status = 'completed';
  await expect(claim()).rejects.toMatchObject({ status: 409 });
  run.status = 'in_progress';
  await expect(claim({ revision: 'other-engine' })).rejects.toMatchObject({ status: 409 });
  await getStore().updateDoc(connectionPath('org', 'github'), { status: 'disconnected' });
  await expect(claim()).rejects.toMatchObject({ code: 'build_connection_changed' });
  expect(await getStore().getDoc(`${buildTasksPath('org')}/${key}`)).toMatchObject({ status: 'queued', attempt: 0 });
});
it('revokes the attempt before cancelling the exact provider run and rejects a late completion', async () => {
  const { claim: leased } = await claim();
  await cancelGithubTask('org', key);
  expect(client).toHaveBeenCalledWith('/repos/Example-Org/typeroll-builder-test/actions/runs/271/cancel', { method: 'POST' });
  expect(await getStore().getDoc(`${buildTasksPath('org')}/${key}`)).toMatchObject({ status: 'cancelled', token_hash: null });
  await expect(new OrganizationBuildQueue().complete('org', key, leased.lease_id, leased.token, { sha256: 'f'.repeat(64), key: `builds/org/tasks/${key}/${leased.lease_id}/artifact.json` })).rejects.toMatchObject({ code: 'build_lease_lost' });
  await expect(claim()).rejects.toMatchObject({ status: 409 });
});
