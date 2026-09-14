import { beforeEach, expect, it, vi } from 'vitest';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { TransferPool, durableTransfer, transferPath, retryDelay, fetchMedia } from '../../lib/media/transfer';
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
it('bounds a thousand mixed transfers by host, bytes and active work', async () => {
  const pool = new TransferPool(4, 100, 2); let active = 0, bytes = 0, maximum = 0;
  const hosts = new Map<string, number>();
  await Promise.all(Array.from({ length: 1000 }, (_, i) => {
    const host = `source-${i % 3}`, size = i % 5 ? 10 : 40;
    return pool.run(host, size, async () => {
      active++; bytes += size; hosts.set(host, (hosts.get(host) ?? 0) + 1); maximum = Math.max(maximum, active);
      expect(active).toBeLessThanOrEqual(4); expect(bytes).toBeLessThanOrEqual(100); expect(hosts.get(host)).toBeLessThanOrEqual(2);
      await new Promise(resolve => setImmediate(resolve));
      active--; bytes -= size; hosts.set(host, hosts.get(host)! - 1);
    });
  }));
  expect(maximum).toBe(4); expect(active).toBe(0);
});
it('coalesces separate importers and resumes a failed file without repeating healthy work', async () => {
  const store = getStore(), copy = vi.fn(async () => ({ mediaId: 'image' }));
  const results = await Promise.all(Array.from({ length: 6 }, () => durableTransfer(store, 'sites/site', 'same-source', copy)));
  expect(copy).toHaveBeenCalledTimes(1); expect(results).toHaveLength(6);
  await expect(durableTransfer(store, 'sites/site', 'broken', async () => { throw Error('connection lost'); })).rejects.toThrow();
  expect(await store.getDoc(transferPath('sites/site', 'broken'))).toMatchObject({ state: 'failed', attempts: 1 });
  await durableTransfer(store, 'sites/site', 'broken', copy);
  await durableTransfer(store, 'sites/site', 'same-source', copy);
  expect(copy).toHaveBeenCalledTimes(2);
  expect(await store.getDoc(transferPath('sites/site', 'broken'))).toMatchObject({ state: 'complete', attempts: 2 });
});
it('honors Retry-After and retries throttling, but leaves permanent failures to the caller', async () => {
  expect(retryDelay('3', 0)).toBe(3000);
  expect(retryDelay(new Date(5000).toUTCString(), 0, 1000)).toBe(4000);
  expect(retryDelay('99999', 0)).toBe(30000);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(new Response('ok'));
  expect((await fetchMedia('https://example.com/image', {}, fetcher)).status).toBe(200);
  const forbidden = vi.fn(async () => new Response(null, { status: 403 }));
  expect((await fetchMedia('https://example.com/image', {}, forbidden)).status).toBe(403);
  expect(forbidden).toHaveBeenCalledTimes(1);
});
