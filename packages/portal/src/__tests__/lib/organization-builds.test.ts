import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { OrganizationBuildQueue, buildTasksPath, buildTaskKey } from '../../lib/builds/queue';
import { getStore } from '../../lib/datastore';
import { BUILD_PROTOCOL, BUILD_RUNTIME, encodeSource, decodeSource, encodeArtifact, decodeArtifact, sha256, type BuildIdentity } from '../../lib/builds/contract.mjs';
import { inspectCloudflareBuildAccess, checkBuildEngine, readBuildEngine, dispatchCloudflareBuild } from '../../lib/builds/cloudflare';
import { ProviderError } from '../../lib/publishing/providers.mjs';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { startCloudflareConnection, CLOUDFLARE_BUILD_SCOPES } from '../../lib/publishing/cloudflare-oauth';
let now = 1000;
const identity = (site = 'site-a', version = 'main'): BuildIdentity => ({ protocol: BUILD_PROTOCOL, org_id: 'org', site_id: site, version_id: version,
  job_id: 'job-a', publication_id: 'a'.repeat(64), source_sha256: 'b'.repeat(64), commit: 'c'.repeat(40), branch: version === 'main' ? 'main' : `version-${version}`, node_version: BUILD_RUNTIME });
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); now = 1000; vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('claims distinct sites and branches concurrently and keeps retries frozen', async () => {
  const queue = new OrganizationBuildQueue(getStore(), () => now);
  for (const value of [identity(), identity('site-b'), identity('site-a', 'redesign')]) await queue.enqueue(value, 'engine-1');
  const claims = await Promise.all(Array.from({ length: 6 }, () => queue.claim('org', 'engine-1', 1)));
  const acquired = claims.filter(x => x !== null);
  expect(acquired).toHaveLength(3); expect(new Set(acquired.map(x => x!.key)).size).toBe(3);
  expect(await queue.claim('other-org', 'engine-1', 1)).toBeNull();
  now += 91000;
  const retry = await queue.claim('org', 'engine-1', 1);
  // Concurrent callers need not finish in queue order. Compare the old lease
  // for the task actually retried, not the first Promise in the callers array.
  const first = acquired.find(claim => claim!.key === retry?.key)!;
  expect(first).toBeDefined();
  expect(retry?.identity).toEqual(first.identity); expect(retry?.token).not.toBe(first.token);
  await expect(queue.heartbeat('org', first.key, first.lease_id, first.token)).rejects.toMatchObject({ code: 'build_lease_lost' });
  await expect(queue.complete('org', first.key, first.lease_id, first.token, { sha256: 'f'.repeat(64), key: `builds/org/tasks/${first.key}/${first.lease_id}/artifact.json` })).rejects.toMatchObject({ code: 'build_lease_lost' });
});
it('rejects incompatible workers, swapped attempt tokens, cancellation and expired jobs', async () => {
  const queue = new OrganizationBuildQueue(getStore(), () => now);
  await queue.enqueue(identity(), 'engine-1');
  await expect(queue.claim('org', 'engine-1', 2)).rejects.toMatchObject({ code: 'build_protocol_unsupported' });
  expect(await queue.claim('org', 'engine-2', 1)).toBeNull();
  const claim = (await queue.claim('org', 'engine-1', 1))!;
  await expect(queue.authorize('other', claim.key, claim.lease_id, claim.token)).rejects.toMatchObject({ code: 'build_lease_lost' });
  await expect(queue.heartbeat('org', claim.key, claim.lease_id, 'wrong')).rejects.toMatchObject({ code: 'build_lease_lost' });
  await queue.cancel('org', claim.key);
  await expect(queue.authorize('org', claim.key, claim.lease_id, claim.token)).rejects.toMatchObject({ code: 'build_lease_lost' });
  await queue.enqueue(identity('site-b'), 'engine-1'); now += 46 * 60_000;
  expect(await queue.claim('org', 'engine-1', 1)).toBeNull();
  expect(await getStore().getDoc(`${buildTasksPath('org')}/${buildTaskKey(identity('site-b'))}`)).toMatchObject({ status: 'failed', error_code: 'build_timeout' });
});
it('completes once and accepts only artifact keys scoped to the leased attempt', async () => {
  const queue = new OrganizationBuildQueue(getStore(), () => now);
  await queue.enqueue(identity(), 'engine-1'); const claim = (await queue.claim('org', 'engine-1', 1))!;
  await expect(queue.complete('org', claim.key, claim.lease_id, claim.token, { sha256: 'f'.repeat(64), key: 'builds/other/artifact.json' })).rejects.toMatchObject({ status: 400 });
  const artifact = { sha256: 'f'.repeat(64), key: `builds/org/tasks/${claim.key}/${claim.lease_id}/artifact.json` };
  await queue.complete('org', claim.key, claim.lease_id, claim.token, artifact);
  await expect(queue.complete('org', claim.key, claim.lease_id, claim.token, artifact)).rejects.toMatchObject({ code: 'build_lease_lost' });
});
it('verifies source and every output file, and rejects foreign identity, tampering and dynamic code', () => {
  const source = encodeSource({ 'publication.json': '{"frozen":true}' });
  expect(decodeSource(source, sha256(source))).toEqual({ 'publication.json': '{"frozen":true}' });
  expect(() => decodeSource(Buffer.from('changed'), sha256(source))).toThrow('integrity');
  expect(() => encodeSource({ '../escape': 'no' })).toThrow('path');
  const files = { 'index.html': Buffer.from('<h1>Static</h1>'), '.well-known/typeroll/publication.json': Buffer.from(JSON.stringify({ id: identity().publication_id })) };
  const artifact = encodeArtifact(identity(), files);
  expect(decodeArtifact(artifact, identity(), sha256(artifact))['index.html'].toString()).toBe('<h1>Static</h1>');
  expect(() => decodeArtifact(artifact, identity('site-b'), sha256(artifact))).toThrow('identity');
  const corrupted = JSON.parse(artifact.toString()); corrupted.files.find((x: any) => x.name === 'index.html').data = Buffer.from('stale').toString('base64');
  const bytes = Buffer.from(JSON.stringify(corrupted)); expect(() => decodeArtifact(bytes, identity(), sha256(bytes))).toThrow('integrity');
  expect(() => encodeArtifact(identity(), { ...files, '_worker.js': Buffer.from('dynamic') })).toThrow('Dynamic');
});
it('reports both denied provider resources without returning token metadata', async () => {
  const denied = vi.fn(async () => { throw new ProviderError('Cloudflare', 403, [10000]); });
  expect(await inspectCloudflareBuildAccess(denied, 'a'.repeat(32))).toMatchObject({ issues: [{ resource: 'workers', http_status: 403, provider_codes: [10000] }, { resource: 'builds', http_status: 403, provider_codes: [10000] }] });
  const allowed = vi.fn(async () => [{ build_token_secret: 'never-return-this' }]);
  const result = await inspectCloudflareBuildAccess(allowed, 'a'.repeat(32)); expect(result.build_tokens).toBe(1); expect(JSON.stringify(result)).not.toContain('never-return');
});
it('never enables an engine based solely on permission reads and rejects stale settings', async () => {
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'connection', cloudflare: { account_id: 'a'.repeat(32), account_name: 'Synthetic build account' }, encrypted_credentials: sealCredentials('org', 'cloudflare', { api_token: 'synthetic-token' }) });
  const denied = vi.fn<typeof fetch>(async () => Response.json({ success: false, errors: [{ code: 10000, message: 'secret must not leak' }] }, { status: 403 }));
  const state = await checkBuildEngine('org', { revision: 'initial' }, denied);
  expect(state).toMatchObject({ state: 'approval_required', enabled: false, issue: { http_status: 403, provider_codes: [10000] } });
  expect(JSON.stringify(state)).not.toContain('secret must not leak');
  const allowed = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: [{}] }));
  const checked = await checkBuildEngine('org', { revision: state.revision }, allowed);
  expect(checked).toMatchObject({ state: 'qualification_required', enabled: false });
  await expect(checkBuildEngine('org', { revision: state.revision }, allowed)).rejects.toMatchObject({ code: 'build_settings_changed' });
  expect((await readBuildEngine('other')).account_id).toBeNull();
});
it('adds build consent only when explicitly requested on the organization connection', async () => {
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost'); vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic'); vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic');
  const session = { orgId: 'org', userId: 'user', email: 'test@example.invalid' };
  const ordinary = new URL((await startCloudflareConnection(session)).url);
  expect(ordinary.searchParams.get('scope')).not.toContain('workers-ci');
  const builds = new URL((await startCloudflareConnection(session, 'default', true)).url);
  for (const scope of CLOUDFLARE_BUILD_SCOPES) expect(builds.searchParams.get('scope')?.split(' ')).toContain(scope);
});
it('dispatches the pinned shared runner commit, never a site branch as the engine revision', async () => {
  const client = vi.fn(async () => ({ build_uuid: '11111111-1111-4111-8111-111111111111' }));
  await dispatchCloudflareBuild(client, { account_id: 'a'.repeat(32), trigger_uuid: '22222222-2222-4222-8222-222222222222', runner_commit: 'c'.repeat(40) });
  expect(client.mock.calls[0]).toEqual([`/accounts/${'a'.repeat(32)}/builds/triggers/22222222-2222-4222-8222-222222222222/builds`, { method: 'POST', body: { branch: 'main', commit_hash: 'c'.repeat(40) } }]);
});
it('preserves previously granted build scopes when renewing the organization connection', async () => {
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost'); vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic'); vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic');
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { revision: 'current', encrypted_credentials: sealCredentials('org', 'cloudflare', { oauth: { scope: 'page.read workers-ci.read workers-ci.write workers-scripts.read workers-scripts.write' } }) });
  const result = await startCloudflareConnection({ orgId: 'org', userId: 'user', email: 'test@example.invalid' });
  expect(new URL(result.url).searchParams.get('scope')).toContain('workers-ci.write');
});

it('finds only the organization build project and confirms token setup without enabling publishing', async () => {
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { status: 'connected', revision: 'connection', cloudflare: { account_id: 'a'.repeat(32), account_name: 'Build account' }, encrypted_credentials: sealCredentials('org', 'cloudflare', { api_token: 'synthetic-token' }) });
  const initial = await readBuildEngine('org');
  const provider = (worker: string, tokens: unknown[]) => vi.fn<typeof fetch>(async url => Response.json({ success: true, result: String(url).endsWith('/workers/scripts') ? [{ id: worker }] : tokens }));
  const missing = await checkBuildEngine('org', { revision: initial.revision }, provider('another-organizations-builder', []));
  expect(missing).toMatchObject({ state: 'build_token_required', worker_found: false, enabled: false });
  const prepared = await checkBuildEngine('org', { revision: missing.revision }, provider(initial.worker_name, []));
  expect(prepared).toMatchObject({ state: 'build_token_required', worker_found: true, enabled: false });
  const complete = await checkBuildEngine('org', { revision: prepared.revision }, provider(initial.worker_name, [{ build_token_secret: 'never-expose-token' }]));
  expect(complete).toMatchObject({ state: 'qualification_required', enabled: false, worker_found: true });
  expect(complete.issue?.message).toContain('Build token found');
  expect(JSON.stringify(complete)).not.toContain('never-expose-token');
});
