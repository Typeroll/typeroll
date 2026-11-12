import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath } from '../../lib/publishing/connections';
import { engineConfigurationPath } from '../../lib/builds/state';
import { requestMediaPreparation, runPendingMediaPreparation, mediaPreparationStatus, unreadableMedia, preparationRetryDelay } from '../../lib/media/preparation';
import { ConnectionError } from '../../lib/publishing/connections';
import { buildTasksPath } from '../../lib/builds/queue';
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(async (..._args: any[]) => ({ key: 'task' })), completed: vi.fn(), transport: vi.fn(async () => {}), source: vi.fn(async (publication: unknown) => ({ 'publication.json': JSON.stringify(publication) })) }));
vi.mock('../../lib/builds/jobs', () => ({ enqueueBuild: mocks.enqueue, completedBuild: mocks.completed }));
vi.mock('../../lib/publishing/source-tree', () => ({ publicationSourceTree: mocks.source }));
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: mocks.transport }));
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Site', media_prefix: 'site-prefix' });
});
async function releaseDelay() {
  const job = (await getStore().listDocs('media_preparations'))[0];
  await getStore().updateDoc(`media_preparations/${job.id}`, { next_at: 0 });
}
it('coalesces uploads and waits for a compatible customer engine without blocking editing', async () => {
  for (let i = 0; i < 20; i++) await requestMediaPreparation('org', 'site');
  expect(mocks.transport).toHaveBeenCalledTimes(1);
  await releaseDelay(); await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'waiting' });
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it('prepares only ready private images, retains new uploads and never creates a publication', async () => {
  const store = getStore();
  await store.setDoc(engineConfigurationPath('org'), { revision: 'engine', status: 'ready', media_preparation: true, runner_commit: 'a'.repeat(40) });
  await store.setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', media_ready: true, cloudflare: { account_id: 'a'.repeat(32), bucket: 'private', public_bucket: 'public' } });
  await store.setDoc(`${paths.media('org', 'site')}/image`, { mime_type: 'image/png', sha256: 'b'.repeat(64), storage: { provider: 'organization_r2', state: 'ready', key: 'private/original' } });
  await store.setDoc(`${paths.media('org', 'site')}/uploading`, { mime_type: 'image/png', storage: { provider: 'organization_r2', state: 'uploading' } });
  await requestMediaPreparation('org', 'site'); await releaseDelay();
  expect(await runPendingMediaPreparation('org')).toBe(true);
  const publication = mocks.source.mock.calls[0][0] as any;
  expect(publication.media_manifest).toMatchObject({ cache_only: true, original_bucket: 'private' });
  expect(publication.media_manifest.entries).toHaveLength(1);
  expect(mocks.enqueue.mock.calls[0][3]).toBe('media_preparation');
  // Agents can match the running job to the organization's active builds.
  const running = await mediaPreparationStatus('org', 'site');
  expect(running).toMatchObject({ state: 'running', build_job_id: mocks.enqueue.mock.calls[0][1].job_id });
  expect(running?.build_job_id).toMatch(/^media-/);
  expect(await store.listDocs(paths.deploy('org', 'site', 'unused').replace(/\/unused$/, ''))).toHaveLength(0);
  await requestMediaPreparation('org', 'site');
  mocks.completed.mockResolvedValue({ task: {}, files: {} });
  await runPendingMediaPreparation('org');
  expect(await store.getDoc(`${paths.media('org', 'site')}/image`)).toMatchObject({ preparation: { state: 'ready', source_sha256: 'b'.repeat(64) } });
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'queued' });
  // A request during the round waits for its quiet window before the next round.
  await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'queued' });
  await releaseDelay(); await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'complete' });
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
});

it('waits for uploads to go quiet, up to a cap, so a slow import series shares one job', async () => {
  const { preparationStartAt, PREPARATION_QUIET_MS, PREPARATION_MAX_WAIT_MS } = await import('../../lib/media/preparation');
  const store = getStore();
  const job = async () => (await store.listDocs<{ next_at: number; first_requested_at: number }>('media_preparations'))[0]!;
  const image = (id: string) => store.setDoc(`${paths.media('org', 'site')}/${id}`, { mime_type: 'image/png', sha256: id.padEnd(64, '0'), storage: { provider: 'organization_r2', state: 'ready', key: id } });
  await image('a'); await requestMediaPreparation('org', 'site', 'a');
  const first = await job();
  expect(first.next_at - first.first_requested_at).toBe(PREPARATION_QUIET_MS);
  // A later upload pushes the start back; the first request still bounds it.
  await store.updateDoc(`media_preparations/${(first as any).id}`, { first_requested_at: Date.now() - PREPARATION_MAX_WAIT_MS + 1000 });
  await image('b'); await requestMediaPreparation('org', 'site', 'b');
  const later = await job();
  expect(later.next_at).toBeLessThanOrEqual(later.first_requested_at + PREPARATION_MAX_WAIT_MS);
  expect(later.next_at).toBeLessThan(Date.now() + PREPARATION_QUIET_MS);
  expect(preparationStartAt(1000, 1000)).toBe(1000 + PREPARATION_QUIET_MS);
  // An explicit request starts without waiting.
  await requestMediaPreparation('org', 'site');
  expect((await job()).next_at).toBeLessThanOrEqual(Date.now());
});

async function configureEngine() {
  const store = getStore();
  await store.setDoc(engineConfigurationPath('org'), { revision: 'engine', status: 'ready', media_preparation: true, runner_commit: 'a'.repeat(40) });
  await store.setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', media_ready: true, cloudflare: { account_id: 'a'.repeat(32), bucket: 'private', public_bucket: 'public' } });
  mocks.completed.mockResolvedValue(null);
  return store;
}
const imageDoc = (hash: string) => ({ mime_type: 'image/png', sha256: hash.repeat(64), storage: { provider: 'organization_r2', state: 'ready', key: `private/${hash}` } });

it('an automatic upload selects only requested images, not a legacy library without readiness flags', async () => {
  const store = await configureEngine();
  for (let i = 0; i < 317; i++) await store.setDoc(`${paths.media('org', 'site')}/legacy-${i}`, imageDoc('a'));
  await store.setDoc(`${paths.media('org', 'site')}/new`, imageDoc('b'));
  const reads = vi.spyOn(store, 'listDocs');
  await requestMediaPreparation('org', 'site', 'new'); await releaseDelay();
  await runPendingMediaPreparation('org');
  const publication = mocks.source.mock.calls[0][0] as any;
  expect(publication.media_manifest.entries.map((entry: any) => entry.id)).toEqual(['new']);
  expect(reads.mock.calls.filter(([path]) => path === paths.media('org', 'site')))
    .toEqual([[paths.media('org', 'site'), { filters: [{ field: 'preparation_pending', op: '==', value: true }] }]]);
  mocks.completed.mockResolvedValue({ task: {}, files: {} });
  await runPendingMediaPreparation('org'); await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'complete' });
  expect(await store.getDoc(`${paths.media('org', 'site')}/new`)).toMatchObject({ preparation_pending: false, preparation: { state: 'ready' } });
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
});

it('finalizing an already prepared image or non-image creates no background work', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/ready`, { ...imageDoc('a'), preparation: { state: 'ready', source_sha256: 'a'.repeat(64), recipe: 'v2' } });
  await store.setDoc(`${paths.media('org', 'site')}/pdf`, { ...imageDoc('b'), mime_type: 'application/pdf' });
  expect(await requestMediaPreparation('org', 'site', 'ready')).toBe(false);
  expect(await requestMediaPreparation('org', 'site', 'pdf')).toBe(false);
  expect(await store.listDocs('media_preparations')).toEqual([]);
  expect(mocks.transport).not.toHaveBeenCalled();
});

it('uploads arriving during an active batch survive completion, including a changed source hash', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/first`, imageDoc('a'));
  await requestMediaPreparation('org', 'site', 'first'); await releaseDelay(); await runPendingMediaPreparation('org');
  await store.setDoc(`${paths.media('org', 'site')}/second`, imageDoc('b'));
  await requestMediaPreparation('org', 'site', 'second');
  await store.updateDoc(`${paths.media('org', 'site')}/first`, { sha256: 'c'.repeat(64) });
  await requestMediaPreparation('org', 'site', 'first');
  mocks.completed.mockResolvedValue({ task: {}, files: {} });
  await runPendingMediaPreparation('org');
  expect(await store.getDoc(`${paths.media('org', 'site')}/first`)).toMatchObject({ preparation_pending: true });
  await releaseDelay(); await runPendingMediaPreparation('org');
  const publication = mocks.source.mock.calls[1][0] as any;
  expect(publication.media_manifest.entries.map((entry: any) => [entry.id, entry.sha256])).toEqual([
    ['first', 'c'.repeat(64)], ['second', 'b'.repeat(64)],
  ]);
});

it('an explicit library retry still discovers legacy images and coalesces with uploads', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/legacy`, imageDoc('a'));
  await store.setDoc(`${paths.media('org', 'site')}/new`, imageDoc('b'));
  await requestMediaPreparation('org', 'site');
  await requestMediaPreparation('org', 'site', 'new'); await releaseDelay(); await runPendingMediaPreparation('org');
  expect((mocks.source.mock.calls[0][0] as any).media_manifest.entries.map((entry: any) => entry.id)).toEqual(['legacy', 'new']);
});

it('finishes a legacy queued library job before switching later uploads to targeted work', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/legacy`, imageDoc('a'));
  await requestMediaPreparation('org', 'site'); await releaseDelay();
  const job = (await store.listDocs<Record<string, unknown>>('media_preparations'))[0];
  const { full_scan, id, ...legacyJob } = job;
  await store.setDoc(`media_preparations/${id}`, legacyJob);
  await runPendingMediaPreparation('org');
  expect((mocks.source.mock.calls[0][0] as any).media_manifest.entries.map((entry: any) => entry.id)).toEqual(['legacy']);
  mocks.completed.mockResolvedValue({ task: {}, files: {} });
  await runPendingMediaPreparation('org'); await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'complete' });
  await store.setDoc(`${paths.media('org', 'site')}/unmarked`, imageDoc('b'));
  await store.setDoc(`${paths.media('org', 'site')}/new`, imageDoc('c'));
  await requestMediaPreparation('org', 'site', 'new'); await releaseDelay(); await runPendingMediaPreparation('org');
  expect((mocks.source.mock.calls[1][0] as any).media_manifest.entries.map((entry: any) => entry.id)).toEqual(['new']);
});

it('an older completed recipe cannot suppress preparation of the full-width candidate', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/old`, { ...imageDoc('a'), preparation: { state: 'ready', source_sha256: 'a'.repeat(64), recipe: 'v1' } });
  await requestMediaPreparation('org', 'site', 'old');
  expect(await store.getDoc(`${paths.media('org', 'site')}/old`)).toMatchObject({ preparation_pending: true });
  expect((await store.listDocs('media_preparations')).length).toBeGreaterThan(0);
});

it('completing a task from before the recipe rollout does not certify the new recipe', async () => {
  const store=await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/image`,imageDoc('a'));
  await requestMediaPreparation('org','site','image'); await releaseDelay(); await runPendingMediaPreparation('org');
  const job=(await store.listDocs('media_preparations'))[0];
  await store.updateDoc(`media_preparations/${job.id}`,{recipe:'v1'});
  mocks.completed.mockResolvedValue({task:{},files:{}});
  await runPendingMediaPreparation('org');
  expect(await store.getDoc(`${paths.media('org', 'site')}/image`)).toMatchObject({preparation_pending:true,preparation:{recipe:'v1'}});
  mocks.completed.mockResolvedValue(null);
  await runPendingMediaPreparation('org');
  expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  expect((await store.listDocs('media_preparations'))[0]).toMatchObject({recipe:'v2'});
});

const decodeFailure = (media: string, overrides: Record<string, unknown> = {}) => ({
  status: 'failed', error_code: 'media_build_process_exit_1',
  error_detail: { cause: `Error: vipspng: libpng read error · step=encode_variant media="${media}" file="/prepared/x" object="x.avif" attempts=1`, lines: [] }, ...overrides,
});

it('skips a library image that does not decode and prepares the rest without it', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/broken`, imageDoc('a'));
  await store.setDoc(`${paths.media('org', 'site')}/logo`, imageDoc('b'));
  await requestMediaPreparation('org', 'site'); await releaseDelay(); await runPendingMediaPreparation('org');
  expect((mocks.source.mock.calls[0][0] as any).media_manifest.entries.map((entry: any) => entry.id)).toEqual(['broken', 'logo']);
  await store.setDoc(`${buildTasksPath('org')}/task`, decodeFailure('broken'));
  mocks.completed.mockRejectedValueOnce(new Error('The build failed while preparing images and files'));
  await runPendingMediaPreparation('org');
  expect(await store.getDoc(`${paths.media('org', 'site')}/broken`)).toMatchObject({ preparation_pending: false, preparation: { state: 'unreadable', source_sha256: 'a'.repeat(64) } });
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'queued', error: null, unreadable_media: ['broken'] });
  // The next round runs at once, without the image that cannot be read.
  await runPendingMediaPreparation('org');
  expect((mocks.source.mock.calls[1][0] as any).media_manifest.entries.map((entry: any) => entry.id)).toEqual(['logo']);
  mocks.completed.mockResolvedValue({ task: {}, files: {} });
  await runPendingMediaPreparation('org'); await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'complete', unreadable_media: ['broken'] });
  // The same bytes are not queued again; a working replacement is.
  expect(await requestMediaPreparation('org', 'site', 'broken')).toBe(false);
  await store.updateDoc(`${paths.media('org', 'site')}/broken`, { sha256: 'c'.repeat(64) });
  expect(await requestMediaPreparation('org', 'site', 'broken')).toBe(true);
});

it('does not mark images unreadable for storage, timeout and unattributed failures', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/image`, imageDoc('a'));
  await requestMediaPreparation('org', 'site'); await releaseDelay(); await runPendingMediaPreparation('org');
  await store.setDoc(`${buildTasksPath('org')}/task`, decodeFailure('image', { error_code: 'media_build_process_exit_1', error_detail: { cause: 'Error: ENOSPC: no space left on device', lines: [] } }));
  mocks.completed.mockRejectedValueOnce(new ConnectionError('The build failed while preparing images and files: the step exited with code 1. (media_build_process_exit_1) Prepared images are retained.', 502, 'media_build_process_exit_1'));
  await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'failed', unreadable_media: [], error_code: 'media_build_process_exit_1', failed_build_task: 'task',
    error: expect.stringContaining('Cause: The build failed while preparing images and files: the step exited with code 1. (media_build_process_exit_1)') });
  expect(await store.getDoc(`${paths.media('org', 'site')}/image`)).not.toHaveProperty('preparation');
  const entries = [{ id: 'image' }];
  expect(unreadableMedia(decodeFailure('image') as any, entries)).toBe('image');
  expect(unreadableMedia(decodeFailure('other') as any, entries)).toBeNull();
  expect(unreadableMedia(decodeFailure('image', { error_code: 'media_build_process_timeout' }) as any, entries)).toBeNull();
  expect(unreadableMedia(decodeFailure('image', { status: 'queued' }) as any, entries)).toBeNull();
  const retried = { cause: 'Error: x · step=encode_variant media="image" attempts=3', lines: [] };
  expect(unreadableMedia(decodeFailure('image', { error_detail: retried }) as any, entries)).toBeNull();
  const storage = { cause: 'Error: media_transfer_interrupted · step=inspect_image media="image" attempts=1', lines: [] };
  expect(unreadableMedia(decodeFailure('image', { error_detail: storage }) as any, entries)).toBeNull();
  const fromLines = { cause: 'Error: Input buffer contains unsupported image format', lines: ['TYPEROLL_MEDIA_FAILURE step=inspect_image media="image" file="/x" object="x" attempts=1'] };
  expect(unreadableMedia(decodeFailure('image', { error_detail: fromLines }) as any, entries)).toBe('image');
});

it('never ends the job for a passing stop; each later round waits longer, up to an hour', async () => {
  const store = await configureEngine();
  await store.setDoc(`${paths.media('org', 'site')}/image`, imageDoc('a'));
  await requestMediaPreparation('org', 'site'); await releaseDelay(); await runPendingMediaPreparation('org');
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  // Cloudflare did not start the runner for a round, more times than any fixed limit.
  for (let round = 1; round <= 6; round++) {
    await store.setDoc(`${buildTasksPath('org')}/task`, { status: 'failed', error_code: 'shared_runner_start_failed' });
    mocks.completed.mockRejectedValueOnce(new ConnectionError('Cloudflare could not start the shared runner. Open Publishing → Builds and check the build project.', 502, 'shared_runner_start_failed'));
    const before = Date.now();
    await runPendingMediaPreparation('org');
    const status = await mediaPreparationStatus('org', 'site');
    expect(status).toMatchObject({ state: 'queued', error: null, error_code: 'shared_runner_start_failed', retry: { attempt: round } });
    expect(Date.parse(status!.retry!.next_at) - before).toBeGreaterThanOrEqual(preparationRetryDelay(round - 1) - 1000);
    // The round waits for its delay, then starts again.
    expect(await runPendingMediaPreparation('org')).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledTimes(round);
    await releaseDelay(); await runPendingMediaPreparation('org');
    expect(mocks.enqueue).toHaveBeenCalledTimes(round + 1);
  }
  expect([0, 1, 2, 3, 4].map(preparationRetryDelay)).toEqual([5, 10, 20, 40, 60].map(minutes => minutes * 60_000));
  // A completed round clears the recorded stop.
  mocks.completed.mockResolvedValueOnce({ task: {}, files: {} });
  await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ error_code: null });
  expect(await mediaPreparationStatus('org', 'site')).not.toHaveProperty('retry');
});

// moveria-es (2026-11-11): a job stopped under Core 0.2.149 or earlier has no error_code,
// so every publication warned "Background image preparation stopped (unknown)".
it('reports why a job that stopped before causes were recorded stopped, from its build task', async () => {
  const store = getStore();
  const legacy = { org: 'org', site: 'site', state: 'failed', request: 'request', lease: null, lease_until: 0, next_at: 0, task: 'old-task',
    error: 'Image preparation stopped. The originals are safe. Retry preparation or publish to prepare the required images.' };
  const path = `media_preparations/${(await import('node:crypto')).createHash('sha256').update('org\0site').digest('hex')}`;
  await store.setDoc(path, legacy);
  await store.setDoc(`${buildTasksPath('org')}/old-task`, { status: 'failed', error_code: 'build_queue_timeout', media_total: 4, media_cursor: 0 });
  const queued = await mediaPreparationStatus('org', 'site');
  expect(queued).toMatchObject({ state: 'failed', error_code: 'build_queue_timeout', failed_build_task: 'old-task' });
  expect(queued?.error).toMatch(/^Image preparation stopped\. .* Cause: The build provider never started a runner/);
  await store.setDoc(`${buildTasksPath('org')}/old-task`, { status: 'cancelled', error_code: null });
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ error_code: 'build_cancelled', error: expect.stringContaining('cancelled the preparation build') });
  // A task that never ended, or no longer exists, cannot say why: report that, not "unknown".
  await store.deleteDoc(`${buildTasksPath('org')}/old-task`);
  const unrecorded = await mediaPreparationStatus('org', 'site');
  expect(unrecorded).toMatchObject({ error_code: 'media_preparation_cause_unrecorded', failed_build_task: 'old-task' });
  expect(unrecorded?.error).toContain('Core 0.2.149 or earlier, which did not record why');
  // A recorded code is never replaced.
  await store.updateDoc(path, { error_code: 'media_build_process_exit_1', failed_task: 'newer-task' });
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ error_code: 'media_build_process_exit_1', failed_build_task: 'newer-task', error: legacy.error });
});
