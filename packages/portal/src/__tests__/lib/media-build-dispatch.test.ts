import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { enqueueBuild, dispatchPendingBuild } from '../../lib/builds/jobs';
import { OrganizationBuildQueue } from '../../lib/builds/queue';
import { buildInputPath, type EngineConfiguration } from '../../lib/builds/state';
const mocks = vi.hoisted(() => ({ put: vi.fn(), dispatch: vi.fn(async () => 'dispatch-1') }));
vi.mock('../../lib/builds/storage', () => ({ buildStorage: async (_org: string, work: any) => work({ account: 'a'.repeat(32), put: mocks.put }) }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => async () => ({ status: 'stopped' }) }));
vi.mock('../../lib/builds/cloudflare', () => ({ dispatchCloudflareBuild: mocks.dispatch }));
vi.mock('../../lib/builds/github', () => ({ githubBuildClient: async () => async () => ({}), readGithubDispatch: async () => ({ id: 1, status: 'completed' }), dispatchGithubBuild: mocks.dispatch }));
const config = { revision: 'engine-1', account_id: 'a'.repeat(32), worker_tag: 'worker', trigger_uuid: 'trigger', runner_commit: 'c'.repeat(40), status: 'ready' } as EngineConfiguration;
const identity = { org_id: 'org', site_id: 'site', version_id: 'redesign', job_id: 'job', publication_id: 'b'.repeat(64), commit: 'c'.repeat(40), branch: 'version-redesign' };
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks(); });
afterEach(() => vi.restoreAllMocks());

it.each([false, true])('uses media batching only when the frozen renderer supports it: %s', async supported => {
  const publication = { media_manifest: { entries: [{ id: 'one' }, { id: 'two' }] }, retained_media_manifests: [{ entries: [{ id: 'retained' }] }] };
  const result = await enqueueBuild(config, identity, { 'publication.json': JSON.stringify(publication), 'scripts/media.mjs': supported ? 'export async function prepareMediaBatch() {}' : 'export async function prepareMedia() {}' });
  expect(result.task.media_total).toBe(supported ? 3 : 0);
  expect(result.task.deadline - result.task.created_at).toBe((supported ? 360 : 45) * 60_000);
  expect(mocks.dispatch).toHaveBeenCalledOnce();
});

it.each(['cloudflare', 'github'] as const)('dispatches the fourth %s media batch without treating successful batches as failed attempts', async provider => {
  const engine = { ...config, provider };
  const result = await enqueueBuild(engine, identity, { 'publication.json': JSON.stringify({ media_manifest: { entries: Array.from({ length: 350 }, (_, id) => ({ id })) } }), 'scripts/media.mjs': 'export async function prepareMediaBatch() {}' });
  const queue = new OrganizationBuildQueue();
  for (let i = 0; i < 3; i++) {
    const claim = (await queue.claim('org', config.revision, 1))!;
    await queue.checkpointMedia('org', result.key, claim.lease_id, claim.token, (i + 1) * 100);
  }
  await getStore().updateDoc(buildInputPath('org', result.key), { dispatch_attempt: 3, dispatch_id: '1', dispatch_lease_until: 0 });
  await dispatchPendingBuild('org', result.key, engine);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  expect(await getStore().getDoc(buildInputPath('org', result.key))).toMatchObject({ dispatch_attempt: 4 });
});
