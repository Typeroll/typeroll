// The store contract every backend must keep, run against each backend.
// Production semantics are Firestore's: merges are deep, a missing field never
// matches a filter, conditional writes never lose an update.
import { beforeEach, describe, expect, it } from 'vitest';
import { getStore, _resetForTests, type ReadWriteStore } from '../../lib/datastore';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { SqlStore, localTransport } from '../../lib/store/sql-store';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { ShardedStore } from '../../lib/store/sharded-store';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

let counter = 0;
const sharded = () => {
  const engines = new Map<string, SqlDocumentEngine>();
  return new ShardedStore({ transport: name => { if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver())); return localTransport(engines.get(name)!); } }, () => `id${++counter}`.padStart(8, '0'));
};
const backends: Array<{ name: string; firestoreSemantics: boolean; globalIndex?: boolean; make: () => Promise<ReadWriteStore> }> = [
  { name: 'sharded', firestoreSemantics: true, globalIndex: false, make: async () => sharded() },
  { name: 'sqlite', firestoreSemantics: true, make: async () => new SqlStore(localTransport(new SqlDocumentEngine(nodeSqliteDriver())), () => `id${++counter}`.padStart(8, '0')) },
  { name: 'fixtures', firestoreSemantics: false, make: async () => { makeTmpFixtures(); await resetDatastore(); _resetForTests(); return getStore(); } },
];

for (const backend of backends) describe(`store contract: ${backend.name}`, () => {
  let store: ReadWriteStore;
  beforeEach(async () => { store = await backend.make(); });

  it('writes, reads and deletes documents with their id', async () => {
    await store.setDoc('things/a', { name: 'A', id: 'ignored', nested: { x: 1 } });
    expect(await store.getDoc('things/a')).toEqual({ id: 'a', name: 'A', nested: { x: 1 } });
    await store.deleteDoc('things/a');
    expect(await store.getDoc('things/a')).toBeNull();
  });

  it('creates a document only once under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.createDocIfMissing('claims/one', { by: i })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('never loses a compare-and-update under concurrency', async () => {
    await store.setDoc('counters/c', { value: 0 });
    await Promise.all(Array.from({ length: 20 }, async () => {
      for (;;) {
        const current = await store.getDoc<{ value: number }>('counters/c');
        if (await store.compareAndUpdateDoc<{ value: number }>('counters/c', doc => doc.value === current!.value, { value: current!.value + 1 })) return;
      }
    }));
    expect(await store.getDoc('counters/c')).toMatchObject({ value: 20 });
  });

  it('applies a multi-document effect atomically or not at all', async () => {
    await store.setDoc('jobs/j', { state: 'a' });
    await store.setDoc('locks/l', { owner: 'x' });
    const job = await store.getDoc('jobs/j');
    expect(await store.compareAndReplaceDoc('jobs/j', job, { state: 'b' }, [{ path: 'locks/l', data: { owner: 'y' }, expected: { id: 'l', owner: 'other' } }])).toBe(false);
    expect(await store.getDoc('jobs/j')).toEqual({ id: 'j', state: 'a' });
    expect(await store.compareAndReplaceDoc('jobs/j', job, { state: 'b' }, [
      { path: 'locks/l', data: { owner: 'y' }, expected: { id: 'l', owner: 'x' } },
      { path: 'guards/g', data: {}, expected: null, guardOnly: true },
    ])).toBe(true);
    expect(await store.getDoc('jobs/j')).toEqual({ id: 'j', state: 'b' });
    expect(await store.getDoc('locks/l')).toEqual({ id: 'l', owner: 'y' });
    expect(await store.getDoc('guards/g')).toBeNull();
    expect(await store.compareAndReplaceDoc('jobs/j', job, { state: 'c' })).toBe(false);
  });

  it('lists a collection in id order with paging and limits, never a subcollection', async () => {
    for (const id of ['c', 'a', 'b']) await store.setDoc(`items/${id}`, { n: id.charCodeAt(0) });
    await store.setDoc('items/a/children/x', { n: 1 });
    expect((await store.listDocs('items', { startAfterId: '' })).map(doc => doc.id)).toEqual(['a', 'b', 'c']);
    expect((await store.listDocs('items', { startAfterId: 'a', limit: 1 })).map(doc => doc.id)).toEqual(['b']);
  });

  it('filters with equality and membership', async () => {
    await store.setDoc('tasks/1', { status: 'queued', attempt: 1 });
    await store.setDoc('tasks/2', { status: 'running', attempt: 2 });
    await store.setDoc('tasks/3', { status: 'done', attempt: 3 });
    expect((await store.listDocs('tasks', { filters: [{ field: 'status', op: '==', value: 'running' }] })).map(doc => doc.id)).toEqual(['2']);
    expect((await store.listDocs('tasks', { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], startAfterId: '' })).map(doc => doc.id)).toEqual(['1', '2']);
    expect((await store.listDocs('tasks', { filters: [{ field: 'attempt', op: '>=', value: 2 }], startAfterId: '' })).map(doc => doc.id)).toEqual(['2', '3']);
  });

  it('deletes a subtree and nothing beside it', async () => {
    await store.setDoc('sites/s/versions/v', { a: 1 });
    await store.setDoc('sites/s/versions/v/pages/p', { a: 1 });
    await store.setDoc('sites/s/versions/w', { a: 1 });
    await store.deleteTree('sites/s/versions/v');
    expect(await store.getDoc('sites/s/versions/v')).toBeNull();
    expect(await store.getDoc('sites/s/versions/v/pages/p')).toBeNull();
    expect(await store.getDoc('sites/s/versions/w')).not.toBeNull();
  });

  it('writes the scheduled-work index with its source', async () => {
    const due = Date.now() + 60_000;
    await store.setDoc('organizations/o/sites/s/deploys/d', { status: 'running', continuation: { due_at: due, token: 't' }, version_id: 'main', environment: 'production' });
    // A sharded store keeps each object's index beside its sources; its alarms replace the global sweep.
    const index = backend.globalIndex === false
      ? await (store as ShardedStore & { store(name: string): ReadWriteStore })['store'](await (store as ShardedStore).shardName('organizations/o/sites/s/deploys/d')).listDocs<{ source: string; due_at: number }>('scheduled_work')
      : await store.listDocs<{ source: string; due_at: number }>('scheduled_work');
    expect(index).toEqual([expect.objectContaining({ source: 'organizations/o/sites/s/deploys/d', due_at: due })]);
  });

  it('refuses writes while reading a snapshot', async () => {
    await store.setDoc('organizations/o/sites/s', { name: 'S' });
    if (!store.readSnapshot) return;
    await expect(store.readSnapshot('organizations/o/sites/s', async () => getStore().setDoc('organizations/o/sites/s', {}))).rejects.toThrow();
  });

  if (backend.firestoreSemantics) {
    it('merges nested maps on update, as Firestore does', async () => {
      await store.setDoc('m/doc', { a: { b: 1, c: 2 }, list: [1, 2] });
      await store.updateDoc('m/doc', { a: { c: 3 }, list: [3], gone: undefined });
      expect(await store.getDoc('m/doc')).toEqual({ id: 'doc', a: { b: 1, c: 3 }, list: [3] });
    });

    it('never matches a missing field, including with !=', async () => {
      await store.setDoc('f/1', { kind: 'a' });
      await store.setDoc('f/2', {});
      expect((await store.listDocs('f', { filters: [{ field: 'kind', op: '!=', value: 'b' }] })).map(doc => doc.id)).toEqual(['1']);
    });

    it('reruns a snapshot read when the root changes underneath it', async () => {
      await store.setDoc('organizations/o/sites/s/pages/p', { title: 'one' });
      let runs = 0;
      const seen = await store.readSnapshot!('organizations/o/sites/s', async () => {
        runs++;
        const page = await getStore().getDoc<{ title: string }>('organizations/o/sites/s/pages/p');
        if (runs === 1) await store.updateDoc('organizations/o/sites/s/pages/p', { title: 'two' });
        return page!.title;
      });
      expect(runs).toBe(2);
      expect(seen).toBe('two');
    });
  }
});
