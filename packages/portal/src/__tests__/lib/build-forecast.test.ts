import { beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { renderCachePath } from '../../lib/builds/state';
import { compareImpact } from '../../lib/publishing/impact';
import { forecastPublicationBuild } from '../../lib/publishing/build-forecast';
const mocks = vi.hoisted(() => ({ head: vi.fn(), renderer: vi.fn() }));
vi.mock('../../lib/builds/storage', () => ({ buildStorage: async (_org: string, work: any) => work({ account: 'owner-account', head: mocks.head }) }));
vi.mock('../../lib/publishing/source-tree', () => ({ currentPublicationRendererDigest: mocks.renderer }));
const scope = { org_id: 'org', site_id: 'site', version_id: 'main' };
const pointer = () => ({ key: 'a'.repeat(64), lease: '11111111-1111-4111-8111-111111111111', sha256: 'b'.repeat(64), account: 'owner-account', created_at: Date.now(),
  diagnostics: { retained_routes: 10, inputs: { renderer: 'c'.repeat(64), globals: 'd'.repeat(64), environment: 'e'.repeat(64) } } });
const impact = () => compareImpact({ protocol: 2, ...scope, core_commit: 'old', entries: [] }, { protocol: 2, ...scope, core_commit: 'new', entries: [] });
const read = (value = impact(), version = 'main') => forecastPublicationBuild('org', 'site', version, value);
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks(); mocks.head.mockResolvedValue({ bytes: 1000 }); mocks.renderer.mockResolvedValue('c'.repeat(64)); });
it('predicts a full build without a cache and scopes every lookup to the selected version', async () => {
  expect(await read()).toMatchObject({ mode: 'full', cache: 'missing', reasons: ['cache_missing'] });
  await getStore().setDoc(renderCachePath(scope), pointer());
  expect(await read()).toMatchObject({ mode: 'automatic', cache: 'available', reuse_verified: false });
  expect(await read(impact(), 'branch')).toMatchObject({ cache: 'missing' });
  expect(mocks.head).toHaveBeenCalledTimes(1);
});
it('distinguishes expiry, account changes, renderer changes and missing objects', async () => {
  const path = renderCachePath(scope);
  await getStore().setDoc(path, { ...pointer(), created_at: Date.now() - 8 * 24 * 60 * 60_000 });
  expect(await read()).toMatchObject({ cache: 'expired' });
  await getStore().setDoc(path, { ...pointer(), account: 'different-account' });
  expect(await read()).toMatchObject({ reasons: ['cache_account_changed'] });
  await getStore().setDoc(path, pointer()); mocks.renderer.mockResolvedValue('f'.repeat(64));
  expect(await read()).toMatchObject({ mode: 'full', reasons: ['renderer_changed'] });
  mocks.head.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
  expect(await read()).toMatchObject({ cache: 'missing', reasons: ['cache_object_missing'] });
});
it('does not invent a reuse guarantee from incomplete metadata, outage or truncated changes', async () => {
  const path = renderCachePath(scope);
  await getStore().setDoc(path, { ...pointer(), diagnostics: undefined });
  expect(await read()).toMatchObject({ mode: 'unknown', reasons: ['cache_metadata_unavailable'] });
  await getStore().setDoc(path, pointer());
  const changed = impact(); changed.total = 100;
  expect(await read(changed)).toMatchObject({ mode: 'unknown', reasons: ['source_changes_not_fully_compared'] });
  mocks.head.mockRejectedValue(new Error('secret provider URL'));
  const result = await read(); expect(result.mode).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('secret');
});
it('predicts shared-input invalidation without counting a Core provenance change as renderer code', async () => {
  await getStore().setDoc(renderCachePath(scope), pointer());
  const changed = impact(); changed.changes.push({ kind: 'partial', id: 'header', title: 'Header', action: 'changed', fields: ['blocks'], date_updated: '', will_deploy: true }); changed.total = 1;
  expect(await read(changed)).toMatchObject({ mode: 'full', reasons: ['global_inputs_changed'] });
  expect(await read()).toMatchObject({ mode: 'automatic' });
});

it('bounds optional forecast waiting when storage does not answer', async () => {
  await getStore().setDoc(renderCachePath(scope), pointer());
  vi.useFakeTimers();
  mocks.head.mockImplementation(() => new Promise(() => {}));
  try {
    const pending = read();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toMatchObject({ mode: 'unknown', reasons: ['cache_check_timeout'], reuse_verified: false });
  } finally { vi.useRealTimers(); }
});

it.each([
  [0, 'cache_empty'],
  [33 * 1024 * 1024, 'cache_too_large'],
])('predicts a full build when stored cache size is unusable: %s', async (bytes, reason) => {
  await getStore().setDoc(renderCachePath(scope), pointer());
  mocks.head.mockResolvedValue({ bytes });
  expect(await read()).toMatchObject({ mode: 'full', reasons: [reason], stored_bytes: bytes });
});
it('refuses malformed cache pointers before issuing storage requests', async () => {
  await getStore().setDoc(renderCachePath(scope), { ...pointer(), key: '../other-site' });
  expect(await read()).toMatchObject({ mode: 'unknown', reasons: ['cache_pointer_invalid'] });
  expect(mocks.head).not.toHaveBeenCalled();
});
