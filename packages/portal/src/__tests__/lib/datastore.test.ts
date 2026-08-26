import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

describe('FixtureStore', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('round-trips a doc through setDoc + getDoc', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc('organizations/o/sites/s', { name: 'Hello' });
    const doc = await store.getDoc<{ name: string }>('organizations/o/sites/s');
    expect(doc?.name).toBe('Hello');
    expect(doc?.id).toBe('s');
  });

  it('addDoc assigns an id and returns it', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const id = await getStore().addDoc('organizations/o/sites/s/media', {
      filename: 'x.png',
    });
    expect(id).toBeTruthy();
    const doc = await getStore().getDoc<{ filename: string }>(`organizations/o/sites/s/media/${id}`);
    expect(doc?.filename).toBe('x.png');
  });

  it('updateDoc merges; setDoc replaces', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc('p/x', { a: 1, b: 2 });
    await store.updateDoc('p/x', { a: 99 });
    expect((await store.getDoc<{ a: number; b: number }>('p/x'))?.b).toBe(2);
    await store.setDoc('p/x', { c: 3 });
    expect((await store.getDoc<{ b?: number; c: number }>('p/x'))?.b).toBeUndefined();
  });

  it('listDocs returns every direct child but not subcollections', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc('p/coll/a', { x: 1 });
    await getStore().setDoc('p/coll/b', { x: 2 });
    await getStore().setDoc('p/coll/c/sub/inner', { x: 3 });
    const docs = await getStore().listDocs<{ x: number }>('p/coll');
    expect(docs.map((d) => d.id).sort()).toEqual(['a', 'b']);
  });

  it('does NOT resolve paths outside the fixtures root', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    // Traversal attempt should throw, not silently escape.
    await expect(
      getStore().setDoc('../escape/danger', { x: 1 }),
    ).rejects.toThrow();
  });

  // Regression: site creation passes `domain: undefined` when the form
  // is empty; the fixtures backend handles it, but Firestore previously
  // rejected the doc. We now configure both backends to ignore undefined
  // values — this asserts the contract on the fixtures side and is a
  // canary for the Firestore-equivalent code path.
  it('writes docs that contain undefined values', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    await expect(
      getStore().setDoc('p/x', { a: 1, missing: undefined }),
    ).resolves.toBeUndefined();
    const back = await getStore().getDoc<{ a: number }>('p/x');
    expect(back?.a).toBe(1);
  });
});
