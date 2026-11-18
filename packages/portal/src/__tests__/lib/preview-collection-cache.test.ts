import { expect, it } from 'vitest';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { localTransport, SqlStore } from '../../lib/store/sql-store';

it('transfers no unchanged collection bytes, but sees updates, deletions, filters and expiry', async () => {
  const engine = new SqlDocumentEngine(nodeSqliteDriver());
  const transport = localTransport(engine);
  const responses: Array<{ token: string; docs?: unknown[] }> = [];
  const original = transport.listVersioned!;
  transport.listVersioned = async (...args) => { const result = await original(...args); responses.push(result); return result; };
  const store = new SqlStore(transport, () => 'unused');
  for (let i = 0; i < 50; i++) await store.setDoc(`pages/p${i}`, { title: `Page ${i}`, html: 'x'.repeat(10000), status: 'published' });
  expect(await store.listDocsCached('pages')).toHaveLength(50);
  const firstBytes = JSON.stringify(responses.at(-1)).length;
  const second = await store.listDocsCached<{ title: string }>('pages');
  expect(responses.at(-1)?.docs).toBeUndefined();
  expect(JSON.stringify(responses.at(-1)).length).toBeLessThan(100);
  second[0]!.title = 'Mutated caller';
  expect((await store.listDocsCached<{ title: string }>('pages'))[0]!.title).toBe('Page 0');
  await store.updateDoc('pages/p0', { title: 'Changed' });
  expect((await store.listDocsCached<{ title: string }>('pages'))[0]!.title).toBe('Changed');
  await store.deleteDoc('pages/p1');
  expect(await store.listDocsCached('pages')).toHaveLength(49);
  expect(await store.listDocsCached('pages', { filters: [{ field: 'status', op: '==', value: 'draft' }] })).toEqual([]);
  await store.setDoc('pages/expired', { delete_at: 1 });
  expect(await store.listDocsCached('pages')).toHaveLength(50);
  const beforeExpiry = engine.sequence();
  engine.removeExpired(Date.now());
  expect(engine.changedSince(beforeExpiry, 'pages')).toBe(true);
  expect(await store.listDocsCached('pages')).toHaveLength(49);
  console.log(JSON.stringify({ benchmark: 'preview-collection-transfer', pages: 50, cold_bytes: firstBytes, unchanged_bytes: JSON.stringify(responses[1]).length }));
});

it('does not share cache entries between independent stores, and revalidates after object recreation', async () => {
  const driver = nodeSqliteDriver();
  let engine = new SqlDocumentEngine(driver);
  const transport = localTransport(engine);
  transport.listVersioned = async (...args) => engine.listVersioned(...args);
  const a = new SqlStore(transport, () => 'id');
  const b = new SqlStore(localTransport(new SqlDocumentEngine(nodeSqliteDriver())), () => 'id');
  await a.setDoc('pages/p', { title: 'Private' });
  expect(await a.listDocsCached('pages')).toHaveLength(1);
  expect(await b.listDocsCached('pages')).toEqual([]);
  engine = new SqlDocumentEngine(driver);
  await a.updateDoc('pages/p', { title: 'Current' });
  expect(await a.listDocsCached('pages')).toMatchObject([{ title: 'Current' }]);
});

it('evicts collection copies across Sites instead of growing isolate memory without bound', async () => {
  const stores = Array.from({ length: 3 }, () => {
    const engine = new SqlDocumentEngine(nodeSqliteDriver()), transport = localTransport(engine);
    const read = transport.listVersioned!; const reused: boolean[] = [];
    transport.listVersioned = async (...args) => { const result = await read(...args); reused.push(!result.docs); return result; };
    return { store: new SqlStore(transport, () => 'id'), reused };
  });
  for (const { store } of stores) {
    for (let i = 0; i < 4; i++) await store.setDoc(`pages/p${i}`, { body: 'x'.repeat(800 * 1024) });
    await store.listDocsCached('pages');
  }
  await stores[0]!.store.listDocsCached('pages');
  expect(stores[0]!.reused).toEqual([false, false]);
});
