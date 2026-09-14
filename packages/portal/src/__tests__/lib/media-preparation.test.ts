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
