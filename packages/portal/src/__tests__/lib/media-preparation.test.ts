import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath } from '../../lib/publishing/connections';
import { engineConfigurationPath } from '../../lib/builds/state';
import { requestMediaPreparation, runPendingMediaPreparation, mediaPreparationStatus } from '../../lib/media/preparation';
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
  expect(await store.listDocs(paths.deploy('org', 'site', 'unused').replace(/\/unused$/, ''))).toHaveLength(0);
  await requestMediaPreparation('org', 'site');
  mocks.completed.mockResolvedValue({ task: {}, files: {} });
  await runPendingMediaPreparation('org');
  expect(await store.getDoc(`${paths.media('org', 'site')}/image`)).toMatchObject({ preparation: { state: 'ready', source_sha256: 'b'.repeat(64) } });
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'queued' });
  await runPendingMediaPreparation('org');
  expect(await mediaPreparationStatus('org', 'site')).toMatchObject({ state: 'complete' });
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
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
  await requestMediaPreparation('org', 'site', 'ready');
  await requestMediaPreparation('org', 'site', 'pdf');
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
  await runPendingMediaPreparation('org');
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
  await requestMediaPreparation('org', 'site', 'new'); await runPendingMediaPreparation('org');
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
