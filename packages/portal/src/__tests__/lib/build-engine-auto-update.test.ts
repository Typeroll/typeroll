import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { encryptSecret } from '../../lib/secret-crypto';
import { engineConfigurationPath, selectionPath, readEngineConfiguration, type EngineConfiguration } from '../../lib/builds/state';
import { enginePath, readBuildEngine } from '../../lib/builds/cloudflare';
import { buildTasksPath, OrganizationBuildQueue, type BuildTask } from '../../lib/builds/queue';
import { configureBuildSettings, readBuildSettings } from '../../lib/builds/selection';
import { engineUpdateFixes } from '../../lib/builds/failure-message';

// Only the provider-mutating setup is replaced; the selection, engine state and queue are the real ones on a synthetic store.
const setup = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock('../../lib/builds/setup', async original => ({ ...await original<object>(), configureBuildEngine: setup.configure }));
const github = vi.hoisted(() => ({ configure: vi.fn(), client: vi.fn() }));
vi.mock('../../lib/builds/github', async original => ({ ...await original<object>(), configureGithubEngine: github.configure, githubBuildClient: async () => github.client }));
const { prepareEngineForBuild, engineUpdateRetryAllowed, ENGINE_UPDATE_WAIT_MS } = await import('../../lib/builds/auto-update');
const { GITHUB_ENGINE_SOURCE } = await import('../../lib/builds/github-source');
const { CLOUDFLARE_ENGINE_SOURCE } = await vi.importActual<typeof import('../../lib/builds/setup')>('../../lib/builds/setup');
const { restorePreviousEngine } = await import('../../lib/builds/engine-restore');

const org = 'org';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function engine(overrides: Partial<EngineConfiguration> = {}): EngineConfiguration {
  return { revision: 'old', status: 'ready', provider: 'cloudflare', engine_source_sha256: 'older-source', static_verification: true, media_preparation: true, publication_validation: 1,
    account_id: 'a'.repeat(32), owner: 'Example', installation_id: '123', worker_tag: 'tag', trigger_uuid: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), runner_commit: '1'.repeat(40),
    token_hash: sha('old-token'), encrypted_token: '', setup_lease_until: 0, ...overrides };
}
const saveEngine = (config: EngineConfiguration) => getStore().setDoc(engineConfigurationPath(org), config);
const autoUpdate = (enabled: boolean) => getStore().setDoc(selectionPath(org), { provider: 'cloudflare', revision: 'sel', auto_update: enabled });
const procRefused = { cause: null, lines: ["bwrap: Can't mount proc on /newroot/proc: Operation not permitted"] };

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  setup.configure.mockReset(); github.configure.mockReset(); github.client.mockReset();
  await getStore().setDoc(enginePath(org), { revision: 'doc', provider: 'cloudflare', enabled: true, state: 'ready', issue: null, account_id: 'a'.repeat(32), account_name: 'Build account', checked_at: null, worker_name: 'w', runner_repo: 'w', protocol: 1, node_version: '22' });
  // An update started by setup: the new revision verifies while the old one is kept for restore.
  setup.configure.mockImplementation(async (_org: string, input: { action: string }) => {
    if (input.action === 'setup') { const previous = await readEngineConfiguration(org); await saveEngine(engine({ revision: 'new', status: 'qualifying', engine_source_sha256: CLOUDFLARE_ENGINE_SOURCE, previous })); }
    return readBuildEngine(org);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('updating an outdated engine as a step of a publication', () => {
  it('leaves the engine alone when the organization has not turned automatic updates on', async () => {
    await saveEngine(engine()); await autoUpdate(false);
    expect(await prepareEngineForBuild(org, 'cloudflare', undefined)).toMatchObject({ state: 'ready', engine: { revision: 'old' } });
    expect(setup.configure).not.toHaveBeenCalled();
  });

  it('updates, waits for verification, then builds on the new engine', async () => {
    await saveEngine(engine()); await autoUpdate(true);
    const started = await prepareEngineForBuild(org, 'cloudflare', undefined, 1000);
    expect(started).toMatchObject({ state: 'waiting', phase: 'updating the build engine', record: { reason: 'update_available', state: 'started', from_revision: 'old' } });
    expect(setup.configure).toHaveBeenCalledWith(org, { action: 'setup', revision: 'doc' });
    const record = started.state === 'waiting' ? started.record : undefined;
    expect(await prepareEngineForBuild(org, 'cloudflare', record)).toMatchObject({ state: 'waiting', phase: 'updating the build engine: verifying the new engine' });
    await saveEngine(engine({ revision: 'new', engine_source_sha256: CLOUDFLARE_ENGINE_SOURCE }));
    expect(await prepareEngineForBuild(org, 'cloudflare', record)).toMatchObject({ state: 'ready', engine: { revision: 'new' }, record: { state: 'updated', to_revision: 'new' } });
  });

  it('builds on the restored previous engine and says so when the update fails', async () => {
    await saveEngine(engine()); await autoUpdate(true);
    const started = await prepareEngineForBuild(org, 'cloudflare', undefined);
    await saveEngine(engine());
    await getStore().updateDoc(enginePath(org), { issue: { code: 'build_engine_update_failed', message: 'The build engine update did not finish (x). The previous engine is back in use and publishing works as before.' } });
    const step = await prepareEngineForBuild(org, 'cloudflare', started.state === 'waiting' ? started.record : undefined);
    expect(step).toMatchObject({ state: 'ready', engine: { revision: 'old' }, record: { state: 'kept' } });
    expect(step.state === 'ready' && step.warning).toContain('previous engine is back in use');
  });

  it('waits for an update another publication or an admin started', async () => {
    await saveEngine(engine({ revision: 'new', status: 'qualifying', previous: engine() })); await autoUpdate(true);
    expect(await prepareEngineForBuild(org, 'cloudflare', undefined)).toMatchObject({ state: 'waiting', record: { state: 'started', from_revision: 'old' } });
    expect(setup.configure).toHaveBeenCalledWith(org, { action: 'check' });
  });

  it('does not update while other builds run: an available update waits, a known failure retries later', async () => {
    await saveEngine(engine()); await autoUpdate(true);
    await getStore().setDoc(`${buildTasksPath(org)}/${'b'.repeat(64)}`, { status: 'running' });
    expect(await prepareEngineForBuild(org, 'cloudflare', undefined)).toMatchObject({ state: 'ready', engine: { revision: 'old' }, record: { state: 'skipped' } });
    const failure = { reason: 'known_failure' as const, state: 'waiting_for_builds' as const, from_revision: 'old', requested_at: 0, failure: 'The build failed.', failure_code: 'dependencies_build_process_exit_1' };
    expect(await prepareEngineForBuild(org, 'cloudflare', failure, 1000)).toMatchObject({ state: 'waiting', phase: 'waiting for other builds before updating the build engine' });
    await expect(prepareEngineForBuild(org, 'cloudflare', failure, ENGINE_UPDATE_WAIT_MS + 1)).rejects.toMatchObject({ code: 'dependencies_build_process_exit_1' });
    expect(setup.configure).not.toHaveBeenCalled();
  });

  it('leaves a current engine alone', async () => {
    await saveEngine(engine({ engine_source_sha256: CLOUDFLARE_ENGINE_SOURCE })); await autoUpdate(true);
    expect(await prepareEngineForBuild(org, 'cloudflare', undefined)).toEqual({ state: 'ready', engine: expect.objectContaining({ revision: 'old' }) });
  });
});

describe('retrying a failed build once on an updated engine', () => {
  it('only for failures a current engine is known to fix', () => {
    expect(engineUpdateFixes('dependencies_build_process_exit_1', procRefused)).toBe(true);
    expect(engineUpdateFixes('sandbox_build_process_exit_1', { cause: null, lines: ["bwrap: Can't mount devpts on /newroot/dev/pts: Operation not permitted"] })).toBe(true);
    expect(engineUpdateFixes('artifact_artifact_format_unsupported')).toBe(true);
    for (const code of ['rendering_build_process_exit_1', 'publication_validation_failed', 'artifact_static_output_size_limit', 'build_enospc'])
      expect(engineUpdateFixes(code, { cause: 'TypeError: x is undefined', lines: [] })).toBe(false);
  });

  it('only with automatic updates on and an update available', async () => {
    await saveEngine(engine()); await autoUpdate(true);
    expect(await engineUpdateRetryAllowed(org, 'cloudflare', 'dependencies_build_process_exit_1', procRefused)).toBe(true);
    expect(await engineUpdateRetryAllowed(org, 'cloudflare', 'rendering_build_process_exit_1', null)).toBe(false);
    await autoUpdate(false);
    expect(await engineUpdateRetryAllowed(org, 'cloudflare', 'dependencies_build_process_exit_1', procRefused)).toBe(false);
    await autoUpdate(true); await saveEngine(engine({ engine_source_sha256: CLOUDFLARE_ENGINE_SOURCE }));
    expect(await engineUpdateRetryAllowed(org, 'cloudflare', 'dependencies_build_process_exit_1', procRefused)).toBe(false);
  });

  it('runs the same frozen task again on the new engine revision', async () => {
    const key = 'c'.repeat(64), path = `${buildTasksPath(org)}/${key}`;
    await getStore().setDoc(path, { identity: { org_id: org }, engine_revision: 'old', status: 'failed', attempt: 2, media_total: 0, media_cursor: 0, error_code: 'dependencies_build_process_exit_1', error_detail: procRefused, lease_until: 0 });
    const task = await new OrganizationBuildQueue().requeue(org, key, 'new');
    expect(task).toMatchObject({ status: 'queued', engine_revision: 'new', attempt: 0, error_code: null, error_detail: null });
    // A task that is not finished is never reset.
    expect(await new OrganizationBuildQueue().requeue(org, key, 'newer')).toMatchObject({ engine_revision: 'new' });
    expect((await getStore().getDoc<BuildTask>(path))!.engine_revision).toBe('new');
  });
});

describe('restoring the previous engine after a failed update', () => {
  beforeEach(async () => {
    await getStore().setDoc(connectionPath(org, 'cloudflare'), { status: 'connected', revision: 'cf', media_ready: true,
      cloudflare: { account_id: 'a'.repeat(32), account_name: 'Build account' }, encrypted_credentials: sealCredentials(org, 'cloudflare', { api_token: 'synthetic-token' }) });
  });

  it('puts back the old revision, commit and runner token', async () => {
    const previous = engine({ encrypted_token: encryptSecret(JSON.stringify({ org, token: 'old-token' })) });
    const failed = engine({ revision: 'new', status: 'disabled', runner_commit: '2'.repeat(40), token_hash: sha('new-token'), previous });
    await saveEngine(failed);
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { requests.push({ url: String(url), method: init.method, body: init.body as string }); return Response.json({ success: true, result: {} }); }));
    expect(await restorePreviousEngine(org, failed, { code: 'build_qualification_failed', message: 'Build verification failed.' })).toBe(true);
    const patch = requests.find(request => request.method === 'PATCH')!;
    expect(patch.url).toContain(`/builds/triggers/${previous.trigger_uuid}/environment_variables`);
    expect(JSON.parse(patch.body!)).toEqual({ TYPEROLL_RUNNER_TOKEN: { value: 'old-token', is_secret: true } });
    expect(await readEngineConfiguration(org)).toMatchObject({ revision: 'old', status: 'ready', runner_commit: '1'.repeat(40), token_hash: sha('old-token'), previous: null });
    expect(await readBuildEngine(org)).toMatchObject({ state: 'ready', enabled: true, issue: { code: 'build_engine_update_failed', cause_code: 'build_qualification_failed' } });
  });

  it('leaves the engine disabled when there is nothing to restore or the token does not match', async () => {
    const failed = engine({ revision: 'new', status: 'disabled', previous: null });
    await saveEngine(failed);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: {} })));
    expect(await restorePreviousEngine(org, failed, { code: 'x', message: 'y' })).toBe(false);
    const tampered = engine({ revision: 'new', status: 'disabled', previous: engine({ encrypted_token: encryptSecret(JSON.stringify({ org, token: 'other' })) }) });
    await saveEngine(tampered);
    expect(await restorePreviousEngine(org, tampered, { code: 'x', message: 'y' })).toBe(false);
    expect(await readEngineConfiguration(org)).toMatchObject({ revision: 'new', status: 'disabled' });
  });
});

describe('the organization setting', () => {
  it('is off for an existing organization until an admin turns it on', async () => {
    await getStore().setDoc(selectionPath(org), { provider: 'cloudflare', revision: 'sel' });
    expect((await readBuildSettings(org)).selection).toMatchObject({ auto_update: false });
    await expect(configureBuildSettings(org, { action: 'auto_update', enabled: true, revision: 'stale' })).rejects.toMatchObject({ code: 'build_settings_changed' });
    const updated = await configureBuildSettings(org, { action: 'auto_update', enabled: true, revision: 'sel' });
    expect(updated.selection).toMatchObject({ auto_update: true, provider: 'cloudflare' });
    expect(updated.selection.revision).not.toBe('sel');
  });
});

describe('the GitHub build engine', () => {
  const githubEngine = (overrides: Partial<EngineConfiguration> = {}) => engine({ provider: 'github', trigger_uuid: '', token_hash: '', engine_source_sha256: 'older-github-source',
    github: { repository_id: '1', owner_id: '2', repo: 'typeroll-github-builder-abc', app_bot: 'publisher[bot]', workflow_id: 3 }, ...overrides });
  const saveGithub = (config: EngineConfiguration) => getStore().setDoc(engineConfigurationPath(org, 'github'), config);
  beforeEach(async () => {
    await getStore().setDoc(enginePath(org, 'github'), { revision: 'gh-doc', provider: 'github', enabled: true, state: 'ready', issue: null, account_id: '2', account_name: 'Example', checked_at: null, worker_name: '', runner_repo: 'typeroll-github-builder-abc', protocol: 1, node_version: '22' });
    github.configure.mockImplementation(async (_org: string, input: { action: string }) => {
      if (input.action === 'setup') { const previous = await readEngineConfiguration(org, 'github'); await saveGithub(githubEngine({ revision: 'new', status: 'qualifying', engine_source_sha256: GITHUB_ENGINE_SOURCE, previous })); }
      return {};
    });
  });

  it('is updated through its own setup and waited for like the Cloudflare engine', async () => {
    await saveGithub(githubEngine()); await getStore().setDoc(selectionPath(org), { provider: 'github', revision: 'sel', auto_update: true });
    const started = await prepareEngineForBuild(org, 'github', undefined);
    expect(started).toMatchObject({ state: 'waiting', record: { state: 'started', from_revision: 'old' } });
    expect(github.configure).toHaveBeenCalledWith(org, { action: 'setup', revision: 'gh-doc' });
    expect(setup.configure).not.toHaveBeenCalled();
    await prepareEngineForBuild(org, 'github', started.state === 'waiting' ? started.record : undefined);
    expect(github.configure).toHaveBeenLastCalledWith(org, { action: 'check', revision: 'gh-doc' });
    await saveGithub(githubEngine({ revision: 'new', engine_source_sha256: GITHUB_ENGINE_SOURCE }));
    expect(await prepareEngineForBuild(org, 'github', started.state === 'waiting' ? started.record : undefined)).toMatchObject({ state: 'ready', engine: { revision: 'new' }, record: { state: 'updated' } });
    expect(await engineUpdateRetryAllowed(org, 'github', 'dependencies_build_process_exit_1', procRefused)).toBe(false);
  });

  it('is restored by moving main back to the previous runner commit', async () => {
    const previous = githubEngine();
    const failed = githubEngine({ revision: 'new', status: 'disabled', runner_commit: '2'.repeat(40), engine_source_sha256: GITHUB_ENGINE_SOURCE, previous });
    await saveGithub(failed);
    github.client.mockResolvedValue({});
    expect(await restorePreviousEngine(org, failed, { code: 'github_qualification_failed', message: 'Verification failed.' })).toBe(true);
    expect(github.client).toHaveBeenCalledWith('/repos/Example/typeroll-github-builder-abc/git/refs/heads/main', { method: 'PATCH', body: { sha: '1'.repeat(40), force: true } });
    expect(await readEngineConfiguration(org, 'github')).toMatchObject({ revision: 'old', status: 'ready', runner_commit: '1'.repeat(40), previous: null });
    expect(await getStore().getDoc(enginePath(org, 'github'))).toMatchObject({ state: 'ready', enabled: true, issue: { code: 'build_engine_update_failed' } });
  });

  it('stays disabled when GitHub refuses to move main back', async () => {
    const failed = githubEngine({ revision: 'new', status: 'disabled', previous: githubEngine() });
    await saveGithub(failed);
    github.client.mockRejectedValue(new Error('HTTP 422'));
    expect(await restorePreviousEngine(org, failed, { code: 'x', message: 'y' })).toBe(false);
    expect(await readEngineConfiguration(org, 'github')).toMatchObject({ revision: 'new', status: 'disabled' });
  });
});
