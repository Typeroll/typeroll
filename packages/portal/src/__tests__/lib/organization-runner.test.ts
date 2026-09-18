import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath } from '../../lib/publishing/connections';
import { OrganizationBuildQueue, buildTasksPath } from '../../lib/builds/queue';
import { engineConfigurationPath, buildInputPath, renderCachePath, assetCachePath } from '../../lib/builds/state';
import { enginePath } from '../../lib/builds/cloudflare';
import { runnerRequest } from '../../lib/builds/runner-http';
import { encodeSource, encodeArtifact, sha256, BUILD_PROTOCOL, BUILD_RUNTIME } from '../../lib/builds/contract.mjs';
import { siteHostingGroup } from '../../lib/publishing/hosting-groups';
import { qualificationFiles } from '../../lib/builds/qualification';
const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>(), grants: vi.fn(async (key: string, write = false) => `https://storage.invalid/${key}?write=${write}`) }));
vi.mock('../../lib/builds/storage', () => ({ buildStorage: async (_org: string, fn: any) => fn({ account: 'a'.repeat(32), read: async (key: string) => { const bytes = storage.objects.get(key); if (!bytes) throw Error('missing'); return bytes; }, grant: storage.grants }) }));
vi.mock('../../lib/publishing/r2-build-credentials', () => ({ customerBuildMediaAccess: vi.fn() }));
const assetGrant = vi.hoisted(() => vi.fn(async () => ({ jwt: 'synthetic-asset-grant' })) );
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => assetGrant }));
const enqueuePublication = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../lib/deploy/queue', () => ({ getDeployQueue: () => ({ enqueue: enqueuePublication }) }));
const runnerToken = 'r'.repeat(43), org = 'org', revision = 'engine-1';
const identity = { org_id: org, site_id: 'site', version_id: 'main', job_id: 'job', publication_id: 'b'.repeat(64), commit: 'c'.repeat(40), branch: 'main', protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME, source_sha256: '' };
const request = (action: string, token = runnerToken, data = {}, organization = org) => runnerRequest(new Request('https://app.example.invalid/api/builds/runner/org/' + action, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, ...data }) }), organization, action);
async function prepare(kind = 'publication', mediaTotal = 0) {
  const source = encodeSource({ 'publication.json': JSON.stringify({ publication_id: identity.publication_id }) });
  const frozen = { ...identity, ...(kind === 'media_preparation' ? { job_id: 'media-request' } : {}), source_sha256: sha256(source) };
  const queued = await new OrganizationBuildQueue().enqueue(frozen, revision, mediaTotal);
  storage.objects.set('builds/org/sources/source.json', source);
  await getStore().setDoc(buildInputPath(org, queued.key), { source_key: 'builds/org/sources/source.json', kind, storage_account_id: 'a'.repeat(32) });
  await getStore().setDoc(engineConfigurationPath(org), { revision, status: kind === 'qualification' ? 'qualifying' : 'ready', account_id: 'a'.repeat(32), installation_id: 'installation', token_hash: sha256(runnerToken), qualification_key: queued.key });
  await getStore().setDoc(paths.deploy(org, 'site', 'job'), { status: 'running', version_id: 'main' });
  return { frozen, key: queued.key };
}
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); storage.objects.clear(); storage.grants.mockClear(); enqueuePublication.mockReset();
  await getStore().setDoc(connectionPath(org, 'cloudflare'), { status: 'connected', cloudflare: { account_id: 'a'.repeat(32) } });
  await getStore().setDoc(connectionPath(org, 'github'), { status: 'connected', github: { installation_id: 'installation' } });
  await getStore().setDoc(enginePath(org), { revision: 'public-revision', enabled: false, state: 'qualification_required' });
});
it('publishes a cache pointer and measured render report only after exact artifact completion', async () => {
  const { frozen, key } = await prepare();
  await getStore().updateDoc(paths.deploy(org, 'site', 'job'), { environment: 'production', git_publication: { publication_id: frozen.publication_id, commit: frozen.commit, build_task_key: key } });
  const claim = await (await request('claim', runnerToken, { protocol: 1, render_cache: true })).json();
  expect(claim.render_cache_supported).toBe(true);
  expect(claim.render_cache).toBeUndefined();
  const attempt = { key, lease_id: claim.lease_id };
  expect((await request('render-cache-upload', runnerToken, attempt)).status).toBe(409);
  expect((await request('render-cache-upload', claim.token, attempt)).status).toBe(200);
  expect(storage.grants).toHaveBeenLastCalledWith(`builds/org/tasks/${key}/${claim.lease_id}/render-cache.json`, true);
  expect(await getStore().getDoc(renderCachePath(frozen))).toBeNull();
  const files = Object.fromEntries(Object.entries(qualificationFiles(identity.publication_id)).map(([name, value]) => [name, Buffer.from(value)]));
  const artifact = encodeArtifact(frozen, files);
  const report = { format: 1, mode: 'partial', rendered: 1, reused: 49, total: 50, removed: 0, reason: 'unchanged_routes_reused' };
  const complete = { ...attempt, sha256: sha256(artifact), render_report: { ...report, secret: 'excluded' }, render_cache_sha256: 'd'.repeat(64) };
  expect((await request('complete', claim.token, complete)).status).not.toBe(200);
  expect(await getStore().getDoc(renderCachePath(frozen))).toBeNull();
  expect(enqueuePublication).not.toHaveBeenCalled();
  storage.objects.set(`builds/org/tasks/${key}/${claim.lease_id}/artifact.json`, artifact);
  expect((await request('complete', claim.token, complete)).status).toBe(200);
  expect(enqueuePublication).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: 'job', versionId: 'main', delayMs: 0 }));
  expect(await getStore().getDoc(renderCachePath(frozen))).toMatchObject({ key, lease: claim.lease_id, sha256: 'd'.repeat(64) });
  expect(await getStore().getDoc(`${buildTasksPath(org)}/${key}`)).toMatchObject({ render_report: report });
  expect((await request('render-cache-upload', claim.token, attempt)).status).toBe(409);
});

it('scopes cache reads to the selected site/version and current storage account', async () => {
  const { frozen } = await prepare();
  const pointer = { key: 'e'.repeat(64), lease: '12345678-1234-1234-1234-123456789012', sha256: 'd'.repeat(64), account: 'a'.repeat(32), created_at: 1 };
  await getStore().setDoc(renderCachePath({ ...frozen, site_id: 'other' }), pointer);
  await getStore().setDoc(renderCachePath({ ...frozen, version_id: 'branch' }), pointer);
  await getStore().setDoc(renderCachePath(frozen), { ...pointer, account: 'f'.repeat(32) });
  const claim = await (await request('claim', runnerToken, { protocol: 1, render_cache: true })).json();
  expect(claim.render_cache).toBeUndefined();
  expect(storage.grants).toHaveBeenCalledTimes(1);
});

it('grants an exact cached object on opt-in without leaking storage credentials', async () => {
  const { frozen } = await prepare();
  const pointer = { key: 'e'.repeat(64), lease: '12345678-1234-1234-1234-123456789012', sha256: 'd'.repeat(64), account: 'a'.repeat(32), created_at: 1 };
  await getStore().setDoc(renderCachePath(frozen), pointer);
  const claim = await (await request('claim', runnerToken, { protocol: 1, render_cache: true })).json();
  expect(claim.render_cache).toEqual({ url: `https://storage.invalid/builds/org/tasks/${pointer.key}/${pointer.lease}/render-cache.json?write=false`, sha256: pointer.sha256 });
});

it.each(['qualification', 'static_verification'])('does not grant render cache writes to %s', async kind => {
  await prepare(kind);
  const claim = await (await request('claim', runnerToken, { protocol: 1, render_cache: true })).json();
  expect(claim.render_cache_supported).toBeUndefined();
  expect((await request('render-cache-upload', claim.token, { key: claim.key, lease_id: claim.lease_id })).status).toBe(409);
});
it('requires completed verification checkpoints and a receipt bound to the frozen source', async () => {
  const { frozen, key } = await prepare('static_verification', 2);
  let claim = await (await request('claim', runnerToken, { protocol: 1, static_verification: true })).json();
  const receipt = () => encodeArtifact(frozen, {
    '.well-known/typeroll/publication.json': Buffer.from(JSON.stringify({ id: frozen.publication_id })),
    'verification.json': Buffer.from(JSON.stringify({ publication_id: frozen.publication_id, source_sha256: frozen.source_sha256, completed: 2 })),
  });
  let artifact = receipt();
  storage.objects.set(`builds/org/tasks/${key}/${claim.lease_id}/artifact.json`, artifact);
  expect((await request('complete', claim.token, { key, lease_id: claim.lease_id, sha256: sha256(artifact) })).status).toBe(409);
  expect((await request('media-access', claim.token, { key, lease_id: claim.lease_id, cursor: 0 })).status).toBe(409);
  expect((await request('direct-upload', claim.token, { key, lease_id: claim.lease_id })).status).toBe(409);
  expect((await request('verification-checkpoint', claim.token, { key, lease_id: claim.lease_id, cursor: 1 })).status).toBe(200);
  expect((await request('heartbeat', claim.token, { key, lease_id: claim.lease_id })).status).toBe(409);
  claim = await (await request('claim', runnerToken, { protocol: 1, static_verification: true })).json();
  expect(claim).toMatchObject({ kind: 'static_verification', media_cursor: 1 });
  expect((await request('verification-checkpoint', claim.token, { key, lease_id: claim.lease_id, cursor: 2, continue_build: true })).status).toBe(200);
  artifact = receipt(); storage.objects.set(`builds/org/tasks/${key}/${claim.lease_id}/artifact.json`, artifact);
  expect((await request('complete', claim.token, { key, lease_id: claim.lease_id, sha256: sha256(artifact) })).status).toBe(200);
});

it('revokes verification work when its parent publication is cancelled', async () => {
  await prepare('static_verification', 1);
  const claim = await (await request('claim', runnerToken, { protocol: 1, static_verification: true })).json();
  await getStore().updateDoc(paths.deploy(org, 'site', 'job'), { status: 'failed' });
  expect((await request('verification-checkpoint', claim.token, { key: claim.key, lease_id: claim.lease_id, cursor: 1, continue_build: true })).status).toBe(409);
});
it('issues upload access only to an active attempt on demand', async () => {
  const { frozen, key } = await prepare();
  expect((await request('claim', 'x'.repeat(43), { protocol: 1 })).status).toBe(401);
  expect((await request('claim', runnerToken, { protocol: 1 }, 'other')).status).toBe(401);
  const response = await request('claim', runnerToken, { protocol: 1 });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const claim = await response.json(); expect(claim.identity).toEqual(frozen); expect(claim.artifact_url).toBeUndefined();
  expect(storage.grants).toHaveBeenCalledTimes(1);
  const attempt = { key, lease_id: claim.lease_id };
  expect((await request('upload', runnerToken, attempt)).status).toBe(409);
  expect((await request('upload', claim.token, attempt)).status).toBe(200);
  expect(storage.grants).toHaveBeenLastCalledWith(`builds/org/tasks/${key}/${claim.lease_id}/artifact.json`, true, 'application/json');
  const binary = await request('upload', claim.token, { ...attempt, artifact_format: 2 });
  expect(binary.status).toBe(200); expect((await binary.json()).content_type).toBe('application/octet-stream');
  expect(storage.grants).toHaveBeenLastCalledWith(`builds/org/tasks/${key}/${claim.lease_id}/artifact.json`, true, 'application/octet-stream');
  expect((await request('upload', claim.token, { ...attempt, artifact_format: 3 })).status).toBe(400);
  await new OrganizationBuildQueue().cancel(org, key);
  expect((await request('upload', claim.token, attempt)).status).toBe(409);
});
it('rejects another version and accepts the verified exact artifact only once', async () => {
  const { frozen, key } = await prepare();
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  const artifactKey = `builds/org/tasks/${key}/${claim.lease_id}/artifact.json`;
  const files = Object.fromEntries(Object.entries(qualificationFiles(identity.publication_id)).map(([key, value]) => [key, Buffer.from(value)]));
  let artifact = encodeArtifact({ ...frozen, version_id: 'redesign', branch: 'version-redesign' }, files);
  storage.objects.set(artifactKey, artifact);
  const attempt = { key, lease_id: claim.lease_id };
  expect((await request('complete', claim.token, { ...attempt, sha256: sha256(artifact) })).status).toBe(502);
  artifact = encodeArtifact(frozen, files); storage.objects.set(artifactKey, artifact);
  expect((await request('complete', claim.token, { ...attempt, sha256: sha256(artifact) })).status).toBe(200);
  expect((await request('complete', claim.token, { ...attempt, sha256: sha256(artifact) })).status).toBe(409);
  expect(await getStore().getDoc(`${buildTasksPath(org)}/${key}`)).toMatchObject({ status: 'completed', token_hash: null, artifact_sha256: sha256(artifact) });
});
it('revokes attempts immediately when publication is cancelled', async () => {
  await prepare(); const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  await getStore().updateDoc(paths.deploy(org, 'site', 'job'), { status: 'failed' });
  expect((await request('heartbeat', claim.token, { key: claim.key, lease_id: claim.lease_id })).status).toBe(409);
  expect(await getStore().getDoc(`${buildTasksPath(org)}/${claim.key}`)).toMatchObject({ status: 'cancelled' });
});
it('activates only after the complete qualification artifact matches', async () => {
  const { frozen, key } = await prepare('qualification');
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  const artifactKey = `builds/org/tasks/${key}/${claim.lease_id}/artifact.json`;
  const files = Object.fromEntries(Object.entries(qualificationFiles(identity.publication_id)).map(([key, value]) => [key, Buffer.from(value)]));
  let artifact = encodeArtifact(frozen, { ...files, 'index.html': Buffer.from('wrong') }); storage.objects.set(artifactKey, artifact);
  const attempt = { key, lease_id: claim.lease_id };
  expect((await request('complete', claim.token, { ...attempt, sha256: sha256(artifact) })).status).toBe(409);
  expect(await getStore().getDoc(enginePath(org))).toMatchObject({ enabled: false });
  artifact = encodeArtifact(frozen, files); storage.objects.set(artifactKey, artifact);
  expect((await request('complete', claim.token, { ...attempt, sha256: sha256(artifact) })).status).toBe(200);
  expect(await getStore().getDoc(enginePath(org))).toMatchObject({ enabled: true, state: 'ready' });
});

it('checkpoints media through the authenticated endpoint and denies old leases', async () => {
  const { key } = await prepare('publication', 100);
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  const attempt = { key, lease_id: claim.lease_id, cursor: 25 };
  expect((await request('media-checkpoint', runnerToken, attempt)).status).toBe(409);
  expect((await request('media-checkpoint', claim.token, attempt)).status).toBe(200);
  expect((await request('upload', claim.token, attempt)).status).toBe(409);
  expect((await request('media-checkpoint', claim.token, attempt)).status).toBe(409);
  const next = await (await request('claim', runnerToken, { protocol: 1 })).json();
  expect(next).toMatchObject({ key, media_cursor: 25, media_total: 100, identity: claim.identity });
  expect(next.token).not.toBe(claim.token);
});

it.each(['media_transfer_interrupted', 'build_process_timeout'])('retries %s in media only three times without losing the frozen task', async code => {
  const { key } = await prepare('publication', 100);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
    expect((await request('fail', claim.token, { key, lease_id: claim.lease_id, stage: 'media', code })).status).toBe(200);
    expect(await getStore().getDoc(`${buildTasksPath(org)}/${key}`)).toMatchObject({ status: attempt < 3 ? 'queued' : 'failed', media_cursor: 0 });
  }
});

it('does not retry integrity or rendering errors as media interruptions', async () => {
  const { key } = await prepare('publication', 100);
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  expect((await request('fail', claim.token, { key, lease_id: claim.lease_id, stage: 'rendering', code: 'build_process_timeout' })).status).toBe(200);
  expect(await getStore().getDoc(`${buildTasksPath(org)}/${key}`)).toMatchObject({ status: 'failed' });
});

it('finishes a small media library in the same build without an extra provider run', async () => {
  const { key } = await prepare('publication', 20);
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  const attempt = { key, lease_id: claim.lease_id, cursor: 20, continue_build: true };
  expect((await request('media-checkpoint', claim.token, { ...attempt, cursor: 10 })).status).toBe(400);
  expect((await request('media-checkpoint', claim.token, attempt)).status).toBe(200);
  expect((await request('upload', claim.token, attempt)).status).toBe(200);
  expect(await getStore().getDoc(`${buildTasksPath(org)}/${key}`)).toMatchObject({ status: 'running', media_cursor: 20, media_batches: 0, attempt: 1 });
});

it('issues asset-only upload access for the frozen hosting group and denies changed targets', async () => {
  const { key } = await prepare();
  await getStore().setDoc(paths.site(org, 'site'), { name: 'Site' });
  const group = await siteHostingGroup(org, 'site');
  const publication = { build_task_key: key, publication_id: identity.publication_id, commit: identity.commit,
    branch: 'main', hosting_group_id: group.id, hosting_group_revision: group.revision, account_id: 'a'.repeat(32), project: 'generated-site' };
  await getStore().updateDoc(paths.deploy(org, 'site', 'job'), { git_publication: publication });
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  const attempt = { key, lease_id: claim.lease_id };
  const grant = await request('direct-upload', claim.token, attempt);
  expect(grant.status).toBe(200);
  expect(await grant.json()).toEqual({ jwt: 'synthetic-asset-grant', target: { account: 'a'.repeat(32), project: 'generated-site' } });
  expect(assetGrant).toHaveBeenLastCalledWith(`/accounts/${'a'.repeat(32)}/pages/projects/generated-site/upload-token`);
  await getStore().updateDoc(paths.deploy(org, 'site', 'job'), { git_publication: { ...publication, account_id: 'b'.repeat(32) } });
  expect((await request('direct-upload', claim.token, attempt)).status).toBe(409);
  await new OrganizationBuildQueue().cancel(org, key);
  expect((await request('direct-upload', claim.token, attempt)).status).toBe(409);
});

it('issues media grants in bounded slices and retains frozen source integrity', async () => {
  const entries = Array.from({ length: 1000 }, (_, id) => ({ id: String(id) }));
  const publication = { publication_id: identity.publication_id, media_manifest: { entries } };
  const source = encodeSource({ 'publication.json': JSON.stringify(publication), 'scripts/media.mjs': 'export async function prepareMediaBatch(materialize = false) {}' });
  const frozen = { ...identity, source_sha256: sha256(source) };
  const queued = await new OrganizationBuildQueue().enqueue(frozen, revision, 1000);
  storage.objects.set('batch-source', source);
  await getStore().setDoc(buildInputPath(org, queued.key), { source_key: 'batch-source', kind: 'publication', storage_account_id: 'a'.repeat(32) });
  await getStore().setDoc(engineConfigurationPath(org), { revision, status: 'ready', account_id: 'a'.repeat(32), installation_id: 'installation', token_hash: sha256(runnerToken) });
  await getStore().setDoc(paths.deploy(org, 'site', 'job'), { status: 'running', version_id: 'main' });
  const { customerBuildMediaAccess } = await import('../../lib/publishing/r2-build-credentials');
  vi.mocked(customerBuildMediaAccess).mockClear();
  vi.mocked(customerBuildMediaAccess).mockResolvedValue({ grant_url: 'https://example.invalid/scoped', sha256: 'a'.repeat(64), publication_id: identity.publication_id });
  const claim = await (await request('claim', runnerToken, { protocol: 1, media_batch_access: true })).json();
  expect(claim.media_access_batched).toBe(true); expect(customerBuildMediaAccess).not.toHaveBeenCalled();
  const attempt = { key: queued.key, lease_id: claim.lease_id, cursor: 450 };
  expect((await request('media-access', claim.token, attempt)).status).toBe(200);
  const selected = vi.mocked(customerBuildMediaAccess).mock.calls[0][2].entries;
  expect(selected).toHaveLength(100); expect(selected[0].id).toBe('450'); expect(selected.at(-1).id).toBe('549');
  expect((await request('media-access', claim.token, { ...attempt, cursor: 1000 })).status).toBe(400);
  await new OrganizationBuildQueue().cancel(org, queued.key);
  expect((await request('media-access', claim.token, attempt)).status).toBe(409);
});

it('accepts a direct upload receipt only with its matching frozen publication marker', async () => {
  const { frozen, key } = await prepare();
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  const markerPath = '.well-known/typeroll/publication.json';
  const marker = Buffer.from(JSON.stringify({ id: frozen.publication_id }));
  const receipt = { format: 1, target: { account: 'a'.repeat(32), project: 'generated-site' }, files: { [markerPath]: { sha256: sha256(marker), size: marker.length }, 'index.html': { sha256: sha256('hello'), size: 5 } },
    controls: {}, manifest: { ['/' + markerPath]: 'a'.repeat(32), '/index.html': 'b'.repeat(32) } };
  const artifact = encodeArtifact(frozen, { '.typeroll-direct-upload.json': Buffer.from(JSON.stringify(receipt)), [markerPath]: marker });
  storage.objects.set(`builds/org/tasks/${key}/${claim.lease_id}/artifact.json`, artifact);
  expect((await request('complete', claim.token, { key, lease_id: claim.lease_id, sha256: sha256(artifact) })).status).toBe(200);
  expect(await getStore().getDoc(`${buildTasksPath(org)}/${key}`)).toMatchObject({ status: 'completed' });
  expect(await getStore().getDoc(assetCachePath(frozen))).toMatchObject({ key, lease: claim.lease_id, sha256: sha256(artifact), identity: frozen, account: 'a'.repeat(32) });
});

it('completes private preparation with a verified marker and no static hosting action', async () => {
  const { frozen, key } = await prepare('media_preparation', 20);
  await getStore().setDoc(paths.site(org, 'site'), { name: 'Site' });
  // The preparation identity must match the coordinator's active private task.
  const store = getStore();
  await store.setDoc(`media_preparations/${sha256('org\0site')}`, { org: 'org', site: 'site', active_request: 'request', state: 'running' });
  const claim = await (await request('claim', runnerToken, { protocol: 1 })).json();
  expect(claim.kind).toBe('media_preparation');
  const attempt = { key, lease_id: claim.lease_id };
  expect((await request('direct-upload', claim.token, attempt)).status).toBe(409);
  expect((await request('media-checkpoint', claim.token, { ...attempt, cursor: 20, continue_build: true })).status).toBe(200);
  const artifact = encodeArtifact(frozen, { 'preparation.json': Buffer.from(JSON.stringify({ publication_id: frozen.publication_id, completed: 20 })),
    '.well-known/typeroll/publication.json': Buffer.from(JSON.stringify({ id: frozen.publication_id })) });
  storage.objects.set(`builds/org/tasks/${key}/${claim.lease_id}/artifact.json`, artifact);
  expect((await request('complete', claim.token, { ...attempt, sha256: sha256(artifact) })).status).toBe(200);
});

it('grants cached asset receipts only for the current organization, site, version and storage account', async () => {
  const { frozen } = await prepare();
  const pointer = { key: 'e'.repeat(64), lease: '12345678-1234-1234-1234-123456789012', sha256: 'd'.repeat(64), account: 'a'.repeat(32), created_at: 1, identity: frozen };
  await getStore().setDoc(assetCachePath(frozen), pointer);
  const claim = await (await request('claim', runnerToken, { protocol: 1, asset_cache: true })).json();
  expect(claim.asset_cache).toEqual({ url: `https://storage.invalid/builds/org/tasks/${pointer.key}/${pointer.lease}/artifact.json?write=false`, sha256: pointer.sha256, identity: frozen });
  expect(await getStore().getDoc(assetCachePath({ ...frozen, version_id: 'other' }))).toBeNull();
});

it.each(['account', 'org_id', 'site_id', 'version_id'])('does not grant a mismatched asset baseline: %s', async field => {
  const { frozen } = await prepare();
  const pointer = { key: 'e'.repeat(64), lease: '12345678-1234-1234-1234-123456789012', sha256: 'd'.repeat(64), account: 'a'.repeat(32), created_at: 1, identity: frozen };
  if (field === 'account') pointer.account = 'f'.repeat(32);
  else pointer.identity = { ...frozen, [field]: 'other' };
  await getStore().setDoc(assetCachePath(frozen), pointer);
  const claim = await (await request('claim', runnerToken, { protocol: 1, asset_cache: true })).json();
  expect(claim.asset_cache).toBeUndefined();
});
