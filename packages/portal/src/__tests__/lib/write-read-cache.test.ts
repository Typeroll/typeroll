import { beforeEach, expect, it } from 'vitest';
import { getStore, withWriteReadCache } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('isolates cached values and invalidates a document after mutations', async () => {
  const base = getStore();
  await base.setDoc('test/a', { value: 1 });
  await withWriteReadCache(async () => {
    const store = getStore();
    const a = await store.getDoc<any>('test/a'); a.value = 999;
    expect(await store.getDoc('test/a')).toEqual({ id: 'a', value: 1 });
    await store.updateDoc('test/a', { value: 2 });
    expect(await store.getDoc('test/a')).toEqual({ id: 'a', value: 2 });
    await store.deleteTree('test');
    expect(await store.getDoc('test/a')).toBeNull();
  });
  expect(getStore()).toBe(base);
});

it('does not let a cached snapshot bypass current compare-and-replace guards', async () => {
  const base = getStore();
  await base.setDoc('test/a', { value: 1 });
  await withWriteReadCache(async () => {
    const expected = await getStore().getDoc('test/a');
    await base.updateDoc('test/a', { value: 2 }); // another writer
    expect(await getStore().compareAndReplaceDoc('test/a', expected, { value: 3 })).toBe(false);
    expect(await getStore().getDoc('test/a')).toEqual({ id: 'a', value: 2 });
  });
});

it('invalidates effect paths and never carries cached reads into another write', async () => {
  const base = getStore();
  await base.setDoc('test/a', { value: 1 });
  await base.setDoc('test/b', { value: 1 });
  await withWriteReadCache(async () => {
    await getStore().getDoc('test/b');
    expect(await getStore().compareAndReplaceDoc('test/a', await getStore().getDoc('test/a'), { value: 2 }, [{ path: 'test/b', data: { value: 3 } }])).toBe(true);
    expect(await getStore().getDoc('test/b')).toEqual({ id: 'b', value: 3 });
  });
  await base.updateDoc('test/b', { value: 4 });
  await withWriteReadCache(async () => expect(await getStore().getDoc('test/b')).toEqual({ id: 'b', value: 4 }));
});
