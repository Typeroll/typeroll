import { beforeEach, expect, it, vi } from 'vitest';
import type { StaticObservation } from '../../lib/builds/verification';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { cacheLayerProbe, isCachedStaticMismatch, MAX_TARGETED_PURGES, OBSERVATIONS_PER_PURGE, recoverPublicationCache } from '../../lib/publishing/cache-recovery';
const dns = vi.hoisted(() => vi.fn());
const variant = vi.hoisted(() => vi.fn());
vi.mock('../../lib/publishing/hosting-dns', () => ({ hostingDns: dns }));
const provider = vi.fn(), jobPath = 'organizations/org/sites/site/deploys/job';
const publication = { publication_id: 'a'.repeat(64) }, origin = 'https://www.example.com';
const route = '/media/0dbb87db1719d69c-illustration.svg';
const probe = { origin, route, expected_status: 404, actual_status: 200, reason: 'status_mismatch' as const, cf_ray: '1234567812345678-ARN', response_headers: { cf_cache_status: 'MISS', age: 181567 } };
const connection = { provider, accountId: 'account', groupId: 'default' };
const purges = () => provider.mock.calls.filter(([path]) => path.endsWith('/purge_cache'));
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  provider.mockImplementation(async path => path.startsWith('/zones?') ? [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' } }] : { id: 'purge' });
  dns.mockResolvedValue(connection);
  variant.mockResolvedValue(404); cacheLayerProbe.status = variant;
  await getStore().setDoc(jobPath, { static_probe: probe });
});
it('recognizes the real stale Pages response even when the outer cache reports MISS', () => {
  expect(isCachedStaticMismatch(probe, origin)).toBe(true);
  const patches: Array<Partial<StaticObservation & { origin: string }>> = [{ actual_status: 503 }, { origin: 'https://other.example.com' }, { response_headers: { cf_cache_status: 'MISS' } }, { response_headers: {} }];
  for (const patch of patches) expect(isCachedStaticMismatch({ ...probe, ...patch }, origin)).toBe(false);
});
it('refreshes one path of this site once, observes, then names the upstream cache without a zone purge', async () => {
  await recoverPublicationCache('org', jobPath, publication, origin, connection);
  expect(provider).toHaveBeenCalledWith('/zones/zone/purge_cache', { method: 'POST', body: { prefixes: ['www.example.com' + route] } });
  for (let i = 0; i < OBSERVATIONS_PER_PURGE; i++) await recoverPublicationCache('org', jobPath, publication, origin, connection);
  const failure = await recoverPublicationCache('org', jobPath, publication, origin, connection).catch(error => error);
  expect(failure).toMatchObject({ code: 'publication_cache_refresh_failed' });
  expect(failure.message).toContain('fresh cache key returns HTTP 404');
  expect(failure.message).toContain('1234567812345678-ARN');
  expect(purges()).toHaveLength(1);
  expect(variant).toHaveBeenCalledWith(new URL(route, origin));
  expect((await getStore().getDoc<any>(jobPath)).cache_recovery).toMatchObject({ state: 'failed', layer: 'upstream_cache', variant_status: 404, targeted_attempts: 1, cf_ray: probe.cf_ray });
});
it('reports a deployment that still contains the file as an origin problem, not a cache problem', async () => {
  variant.mockResolvedValue(200);
  await recoverPublicationCache('org', jobPath, publication, origin, connection);
  for (let i = 0; i < OBSERVATIONS_PER_PURGE; i++) await recoverPublicationCache('org', jobPath, publication, origin, connection);
  const failure = await recoverPublicationCache('org', jobPath, publication, origin, connection).catch(error => error);
  expect(failure.message).toContain('not a cache problem');
  expect((await getStore().getDoc<any>(jobPath)).cache_recovery).toMatchObject({ layer: 'origin', variant_status: 200 });
});
it('bounds purges across different stale files of one publication', async () => {
  for (let i = 0; i < MAX_TARGETED_PURGES; i++) {
    await getStore().updateDoc(jobPath, { static_probe: { ...probe, route: `/media/old-${i}.svg` } });
    await recoverPublicationCache('org', jobPath, publication, origin, connection);
  }
  await getStore().updateDoc(jobPath, { static_probe: { ...probe, route: '/removed-page/' } });
  await expect(recoverPublicationCache('org', jobPath, publication, origin, connection)).rejects.toMatchObject({ code: 'publication_cache_refresh_failed' });
  expect(purges()).toHaveLength(MAX_TARGETED_PURGES);
});
it.each(['//other.example.com/file', '/media/file?secret=x', '/media/../file'])('does not purge an ambiguous probe route %s', async route => {
  await getStore().updateDoc(jobPath, { static_probe: { ...probe, route } });
  await recoverPublicationCache('org', jobPath, publication, origin, connection);
  expect(provider).not.toHaveBeenCalled();
});
it('explains external DNS recovery without purging', async () => {
  await expect(recoverPublicationCache('org', jobPath, publication, origin, null)).rejects.toMatchObject({ code: 'publication_cache_refresh_external' });
  expect(purges()).toHaveLength(0);
});
it('leaves another site in the same zone untouched through every recovery step', async () => {
  // A zone cache keyed by URL, with the purge semantics Cloudflare documents.
  const cache = new Map([
    ['https://site-a.example.com/_assets/old-1111111111111111.css', 'a-old'], ['https://site-a.example.com/', 'a-home'],
    ['https://site-b.example.com/_assets/old-1111111111111111.css', 'b-asset'], ['https://site-b.example.com/', 'b-home'],
    ['https://v-12345678-site-b.example.com/_assets/share/share-2222222222222222.jpg', 'b-preview'],
  ]);
  provider.mockImplementation(async (path: string, options?: { body?: any }) => {
    if (path.startsWith('/zones?')) return [{ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' } }];
    if (path.endsWith('/purge_cache')) {
      const body = options!.body;
      if (body.purge_everything) cache.clear();
      for (const prefix of body.prefixes ?? []) for (const key of [...cache.keys()]) if (key.replace('https://', '').startsWith(prefix)) cache.delete(key);
      for (const host of body.hosts ?? []) for (const key of [...cache.keys()]) if (new URL(key).hostname === host) cache.delete(key);
      for (const file of body.files ?? []) cache.delete(file);
    }
    return { id: 'purge' };
  });
  const a = 'https://site-a.example.com', staleRoute = '/_assets/old-1111111111111111.css';
  await getStore().setDoc(jobPath, { static_probe: { ...probe, origin: a, route: staleRoute } });
  await recoverPublicationCache('org', jobPath, publication, a, connection);
  for (let i = 0; i < OBSERVATIONS_PER_PURGE; i++) await recoverPublicationCache('org', jobPath, publication, a, connection);
  await expect(recoverPublicationCache('org', jobPath, publication, a, connection)).rejects.toMatchObject({ code: 'publication_cache_refresh_failed' });
  expect(cache.has(`${a}${staleRoute}`)).toBe(false);
  expect([...cache.keys()].filter(key => key.includes('site-b'))).toHaveLength(3);
  expect(cache.get('https://site-a.example.com/')).toBe('a-home');
  for (const [, options] of purges()) {
    expect(options.body.purge_everything).toBeUndefined();
    expect(JSON.stringify(options.body)).not.toContain('site-b');
  }
});
