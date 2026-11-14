import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { OrganizationBuildQueue, buildTasksPath, QUEUED_BUILD_LIMIT_MS, type BuildTask } from '../../lib/builds/queue';
import { buildInputPath, type BuildInput, type EngineConfiguration } from '../../lib/builds/state';
import { BUILD_PROTOCOL, BUILD_RUNTIME, type BuildIdentity } from '../../lib/builds/contract.mjs';
import { buildFailureMessage } from '../../lib/builds/failure-message';

// A fake provider: the Cloudflare build status the coordinator reads, and the dispatches it makes.
const provider = vi.hoisted(() => ({ status: 'queued', dispatch: vi.fn(async () => 'dispatch-2') }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => async () => ({ status: provider.status }) }));
vi.mock('../../lib/builds/cloudflare', async original => ({ ...await original<typeof import('../../lib/builds/cloudflare')>(), dispatchCloudflareBuild: provider.dispatch }));

const { dispatchPendingBuild } = await import('../../lib/builds/jobs');
const { publicationBuildProgress } = await import('../../lib/builds/public-progress');
const { buildActivity } = await import('../../lib/builds/activity');
const { waitForBuild } = await import('../../lib/scheduling/continuation');

const MINUTE = 60_000, start = Date.parse('2026-11-09T10:00:00.000Z');
let now = start;
const config = { revision: 'engine-1', account_id: 'a'.repeat(32), worker_tag: 'worker', trigger_uuid: 'trigger', runner_commit: 'c'.repeat(40), status: 'ready', provider: 'cloudflare' } as EngineConfiguration;
const identity = (job: string, site = 'site'): BuildIdentity => ({ protocol: BUILD_PROTOCOL, org_id: 'org', site_id: site, version_id: 'main', job_id: job,
  publication_id: 'a'.repeat(64), source_sha256: 'b'.repeat(64), commit: 'c'.repeat(40), branch: 'main', node_version: BUILD_RUNTIME });
const queue = () => new OrganizationBuildQueue(getStore(), () => now);
async function enqueue(job: string, kind: BuildInput['kind'] = 'publication', input: Partial<BuildInput> = {}, mediaTotal = 0) {
  const { key } = await queue().enqueue(identity(job), config.revision, mediaTotal, kind === 'static_verification' || kind === 'media_preparation' ? kind : undefined);
  await getStore().setDoc(buildInputPath('org', key), { kind, provider: 'cloudflare', source_key: 'source', storage_account_id: config.account_id, dispatch_id: `dispatch-${job}`, ...input } satisfies BuildInput);
  await getStore().setDoc(paths.deploy('org', 'site', job), { id: job, status: 'running', version_id: 'main', phase: 'building on Cloudflare', git_publication: { build_task_key: key } });
  return key;
}
const task = async (key: string) => (await getStore().getDoc<BuildTask>(`${buildTasksPath('org')}/${key}`))!;

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  now = start; provider.status = 'queued';
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = (ms: number) => { now += ms; vi.setSystemTime(now); };

it('keeps a step queued at the provider past 15 minutes and starts its working time at the claim', async () => {
  const key = await enqueue('job');
  advance(20 * MINUTE);
  await dispatchPendingBuild('org', key, config);
  expect(provider.dispatch).not.toHaveBeenCalled();
  expect(await getStore().getDoc(buildInputPath('org', key))).toMatchObject({ provider_status: 'queued', provider_status_at: now });
  expect(await task(key)).toMatchObject({ status: 'queued', error_code: null });
  const claim = (await queue().claim('org', config.revision, BUILD_PROTOCOL))!;
  expect(claim.key).toBe(key);
  // The full 45 minutes count from the claim, not from the enqueue.
  expect(claim.deadline).toBe(now + 45 * MINUTE);
  expect(await task(key)).toMatchObject({ status: 'running', deadline: now + 45 * MINUTE });
  // An older engine checks its leased work against the server deadline it was given.
  advance(44 * MINUTE);
  await expect(queue().heartbeat('org', key, claim.lease_id, claim.token)).rejects.toMatchObject({ code: 'build_lease_lost' });
});

it('keeps the working time a media window had left while its next window waits in the queue', async () => {
  const key = await enqueue('job', 'publication', {}, 250);
  const first = (await queue().claim('org', config.revision, BUILD_PROTOCOL))!;
  expect(first.deadline).toBe(now + 6 * 60 * MINUTE);
  advance(MINUTE);
  await queue().checkpointMedia('org', key, first.lease_id, first.token, 100);
  advance(90 * MINUTE);
  const next = (await queue().claim('org', config.revision, BUILD_PROTOCOL))!;
  expect(next.media_cursor).toBe(100);
  expect(next.deadline).toBe(first.deadline + 90 * MINUTE);
});

it('fails a step that no runner claimed within the queue cap with a clear code', async () => {
  const key = await enqueue('job');
  advance(QUEUED_BUILD_LIMIT_MS - MINUTE);
  expect(await queue().claim('org', 'other-engine', BUILD_PROTOCOL)).toBeNull();
  expect(await task(key)).toMatchObject({ status: 'queued' });
  advance(MINUTE);
  expect(await queue().claim('org', config.revision, BUILD_PROTOCOL)).toBeNull();
  expect(await task(key)).toMatchObject({ status: 'failed', error_code: 'build_queue_timeout', completed_at: now });
  expect(buildFailureMessage('build_queue_timeout')).toMatch(/^The build provider never started a runner for this queued step: no runner claimed it within 6 hours\./);
});

it('dispatches again when the provider stopped the build before anyone claimed the step', async () => {
  const key = await enqueue('job');
  provider.status = 'stopped';
  advance(20 * MINUTE);
  await dispatchPendingBuild('org', key, config);
  expect(provider.dispatch).toHaveBeenCalledOnce();
  expect(await getStore().getDoc(buildInputPath('org', key))).toMatchObject({ dispatch_id: 'dispatch-2', dispatch_attempt: 1, provider_status: null });
  expect(await task(key)).toMatchObject({ status: 'queued' });
  // Bounded by the existing dispatch attempt limit.
  await getStore().updateDoc(buildInputPath('org', key), { dispatch_attempt: 3, dispatch_lease_until: 0 });
  await expect(dispatchPendingBuild('org', key, config)).rejects.toMatchObject({ code: 'shared_runner_start_failed' });
});

it('does not count a dispatch whose runner served another step of the organization', async () => {
  // Twelve queued media rounds on one build account: each step's own dispatch
  // starts a runner that takes the organization's next step instead.
  const waiting = await enqueue('media-waiting', 'media_preparation', { dispatch_started_at: now }, 10);
  advance(MINUTE);
  const other = await enqueue('media-other', 'media_preparation', {}, 10);
  await getStore().updateDoc(`${buildTasksPath('org')}/${waiting}`, { created_at: now + MINUTE });
  expect((await queue().claim('org', config.revision, BUILD_PROTOCOL))!.key).toBe(other);
  provider.status = 'stopped';
  advance(MINUTE);
  await getStore().updateDoc(buildInputPath('org', waiting), { dispatch_attempt: 3, dispatch_lease_until: 0 });
  await dispatchPendingBuild('org', waiting, config);
  expect(provider.dispatch).toHaveBeenCalledOnce();
  // Waiting its turn is not a failed start: the step stays queued, the count unchanged.
  expect(await getStore().getDoc(buildInputPath('org', waiting))).toMatchObject({ dispatch_id: 'dispatch-2', dispatch_attempt: 3 });
  expect(await task(waiting)).toMatchObject({ status: 'queued' });
});

it('still fails the start when no runner claimed any step after the dispatch', async () => {
  const key = await enqueue('job', 'publication', { dispatch_started_at: now });
  provider.status = 'stopped';
  advance(MINUTE);
  await getStore().updateDoc(buildInputPath('org', key), { dispatch_attempt: 3, dispatch_lease_until: 0 });
  await expect(dispatchPendingBuild('org', key, config)).rejects.toMatchObject({ code: 'shared_runner_start_failed' });
});

it('still claims interactive work before background media preparation', async () => {
  const media = await enqueue('media-site', 'media_preparation', {}, 10);
  advance(MINUTE);
  const publication = await enqueue('job');
  expect((await queue().claim('org', config.revision, BUILD_PROTOCOL))!.key).toBe(publication);
  expect((await queue().claim('org', config.revision, BUILD_PROTOCOL))!.key).toBe(media);
});

it('reports a step waiting for the provider while background media preparation runs, in progress, activity and the phase', async () => {
  const media = await enqueue('media-site', 'media_preparation', {}, 10);
  expect((await queue().claim('org', config.revision, BUILD_PROTOCOL))!.key).toBe(media);
  advance(MINUTE);
  const key = await enqueue('job', 'static_verification', {}, 4);
  const job = (await getStore().getDoc<any>(paths.deploy('org', 'site', 'job')))!;
  await getStore().updateDoc(paths.deploy('org', 'site', 'job'), { git_publication: { verification_task_key: key } });
  advance(6 * MINUTE);
  // The media runner keeps its lease alive with heartbeats.
  await getStore().updateDoc(`${buildTasksPath('org')}/${media}`, { lease_until: now + 90_000 });
  await dispatchPendingBuild('org', key, config);
  const progress = await publicationBuildProgress('org', 'site', { ...job, git_publication: { verification_task_key: key } });
  expect(progress).toMatchObject({ status: 'queued', step: 'waiting_for_runner', deadline: null, queue: {
    state: 'waiting_for_provider', provider: 'cloudflare', provider_status: 'queued', queued_for_seconds: 360, ahead: 0, ahead_kinds: [], running_kinds: ['media_preparation'],
    queued_at: new Date(start + MINUTE).toISOString(), expires_at: new Date(start + MINUTE + QUEUED_BUILD_LIMIT_MS).toISOString(),
    message: 'waiting for Cloudflare to start the verification build (queued 6 min; this organization’s background media preparation is running on the same build account)' } });
  const active = (await buildActivity('org', now)).active_jobs.find(entry => entry.key === key)!;
  expect(active).toMatchObject({ status: 'queued', phase: progress!.queue!.message, queue: { state: 'waiting_for_provider', provider_status: 'queued' } });
  // The coordinator rechecks its own queued step every minute and says why it waits.
  await waitForBuild(paths.deploy('org', 'site', 'job'), 'org', key);
  const waiting = (await getStore().getDoc<any>(paths.deploy('org', 'site', 'job')))!;
  expect(waiting).toMatchObject({ phase: progress!.queue!.message, build_wait: { key, resume_phase: 'building on Cloudflare' }, continuation: { due_at: now + MINUTE } });
});

it('reports other organization builds ahead, and restores the working phase once a runner claims the step', async () => {
  await enqueue('first');
  advance(MINUTE);
  const key = await enqueue('job');
  const jobPath = paths.deploy('org', 'site', 'job');
  await getStore().updateDoc(jobPath, { phase: 'building on Cloudflare' });
  const progress = await publicationBuildProgress('org', 'site', (await getStore().getDoc<any>(jobPath))!);
  expect(progress!.queue).toMatchObject({ state: 'waiting_for_other_builds', ahead: 1, ahead_kinds: ['publication'], provider_status: null,
    message: 'waiting for 1 other build in this organization (queued less than a minute)' });
  expect((await buildActivity('org', now)).active_jobs.find(entry => entry.key === key)).toMatchObject({ queue: { state: 'waiting_for_other_builds', ahead: 1 } });
  await waitForBuild(jobPath, 'org', key);
  expect(await getStore().getDoc(jobPath)).toMatchObject({ phase: progress!.queue!.message, continuation: { due_at: now + 15_000 } });
  // The first build is claimed; now nothing is ahead, and this step waits for the provider.
  await queue().claim('org', config.revision, BUILD_PROTOCOL);
  expect((await publicationBuildProgress('org', 'site', (await getStore().getDoc<any>(jobPath))!))!.queue).toMatchObject({ state: 'waiting_for_provider', running_kinds: ['publication'] });
  await queue().claim('org', config.revision, BUILD_PROTOCOL);
  expect(await task(key)).toMatchObject({ status: 'running' });
  await waitForBuild(jobPath, 'org', key);
  expect(await getStore().getDoc(jobPath)).toMatchObject({ phase: 'building on Cloudflare', build_wait: null, continuation: { due_at: null } });
  expect(await publicationBuildProgress('org', 'site', (await getStore().getDoc<any>(jobPath))!)).toMatchObject({ status: 'running', queue: null });
});
