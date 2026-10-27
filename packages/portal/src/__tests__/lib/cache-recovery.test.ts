import { beforeEach, expect, it, vi } from 'vitest';
import type { StaticObservation } from '../../lib/builds/verification';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { applyApprovedCacheRefresh, isCachedStaticMismatch, recoverPublicationCache } from '../../lib/publishing/cache-recovery';
const dns = vi.hoisted(() => vi.fn());
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: dns }));
const provider = vi.fn(), jobPath = 'organizations/org/sites/site/deploys/job';
const publication = { publication_id: 'a'.repeat(64) }, origin = 'https://www.example.com';
const route = '/media/0dbb87db1719d69c-illustration.svg';
const probe = { origin, route, expected_status: 404, actual_status: 200, reason: 'status_mismatch' as const, cf_ray: '1234567812345678-ARN', response_headers: { cf_cache_status: 'MISS', age: 181567 } };
const connection = { provider, accountId: 'account', groupId: 'default' };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  provider.mockImplementation(async path => path.startsWith('/zones?') ? [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' } }] : { id: 'purge' });
  dns.mockResolvedValue(connection);
  await getStore().setDoc(jobPath, { static_probe: probe });
});
it('recognizes the real stale Pages response even when the outer cache reports MISS', () => {
  expect(isCachedStaticMismatch(probe, origin)).toBe(true);
  const patches: Array<Partial<StaticObservation & { origin: string }>> = [{ actual_status: 503 }, { origin: 'https://other.example.com' }, { response_headers: { cf_cache_status: 'MISS' } }, { response_headers: {} }];
  for (const patch of patches) expect(isCachedStaticMismatch({ ...probe, ...patch }, origin)).toBe(false);
});
it('refreshes exactly one path then requires explicit zone approval instead of looping', async () => {
  await recoverPublicationCache('org', jobPath, publication, origin, connection);
  expect(provider).toHaveBeenCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { prefixes: ['www.example.com' + route] } });
  for (let i = 0; i < 5; i++) await recoverPublicationCache('org', jobPath, publication, origin, connection);
  await expect(recoverPublicationCache('org', jobPath, publication, origin, connection)).rejects.toMatchObject({ code: 'publication_cache_refresh_required' });
  expect(provider.mock.calls.filter(([path]) => path.endsWith('/purge_cache'))).toHaveLength(1);
  expect((await getStore().getDoc<any>(jobPath)).cache_recovery).toMatchObject({ state: 'approval_required', zone_name: 'example.com', publication_id: publication.publication_id, targeted_attempts: 1 });
  expect(await applyApprovedCacheRefresh('org', jobPath, publication)).toBe(false);
});
it('bounds retries across different stale files and leaves current bytes checks intact', async () => {
  for (let i = 0; i < 3; i++) {
    await getStore().updateDoc(jobPath, { static_probe: { ...probe, route: `/media/old-${i}.svg` } });
    await recoverPublicationCache('org', jobPath, publication, origin, connection);
  }
  await getStore().updateDoc(jobPath, { static_probe: { ...probe, route: '/removed-page/' } });
  await expect(recoverPublicationCache('org', jobPath, publication, origin, connection)).rejects.toMatchObject({ code: 'publication_cache_refresh_required' });
  expect(provider.mock.calls.filter(([path]) => path.endsWith('/purge_cache'))).toHaveLength(3);
});
it.each(['//other.example.com/file', '/media/file?secret=x', '/media/../file'])('does not purge an ambiguous probe route %s', async route => {
  await getStore().updateDoc(jobPath, { static_probe: { ...probe, route } });
  await recoverPublicationCache('org', jobPath, publication, origin, connection);
  expect(provider).not.toHaveBeenCalled();
});
it('keeps verification-only retries read-only and explains external DNS recovery', async () => {
  await expect(recoverPublicationCache('org', jobPath, publication, origin, connection, false)).rejects.toMatchObject({ code: 'publication_cache_refresh_required' });
  expect(provider.mock.calls.some(([p]) => p.endsWith('/purge_cache'))).toBe(false);
  await expect(recoverPublicationCache('org', jobPath, publication, origin, null)).rejects.toMatchObject({ code: 'publication_cache_refresh_external' });
});
it('performs an approved zone refresh once, then still rejects stale bytes', async () => {
  await recoverPublicationCache('org', jobPath, publication, origin, connection);
  const state = (await getStore().getDoc<any>(jobPath)).cache_recovery;
  await getStore().updateDoc(jobPath, { cache_recovery: { ...state, state: 'zone_approved' } });
  expect(await applyApprovedCacheRefresh('org', jobPath, publication)).toBe(true);
  expect(provider).toHaveBeenLastCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { purge_everything: true } });
  expect(await applyApprovedCacheRefresh('org', jobPath, publication)).toBe(false);
  for (let i = 0; i < 5; i++) await recoverPublicationCache('org', jobPath, publication, origin, connection);
  await expect(recoverPublicationCache('org', jobPath, publication, origin, connection)).rejects.toMatchObject({ code: 'publication_cache_refresh_failed' });
  expect(provider.mock.calls.filter(([path]) => path.endsWith('/purge_cache'))).toHaveLength(2);
});
it('refuses changed publication, zone or DNS connection before a broad purge', async () => {
  await recoverPublicationCache('org', jobPath, publication, origin, connection);
  const state = (await getStore().getDoc<any>(jobPath)).cache_recovery;
  for (const patch of [{ publication_id: 'changed' }, { zone_id: 'other' }, { dns_account_id: 'other' }, { dns_group_id: 'other' }]) {
    await getStore().updateDoc(jobPath, { cache_recovery: { ...state, ...patch, state: 'zone_approved' } });
    await expect(applyApprovedCacheRefresh('org', jobPath, publication)).rejects.toMatchObject({ code: 'publication_cache_scope_changed' });
  }
  expect(provider.mock.calls.filter(([path]) => path.endsWith('/purge_cache'))).toHaveLength(1);
});
