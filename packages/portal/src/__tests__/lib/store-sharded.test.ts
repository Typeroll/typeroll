import { expect, it } from 'vitest';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { localTransport, type StoreTransport } from '../../lib/store/sql-store';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { ShardedStore, ownerPath, shardFor } from '../../lib/store/sharded-store';

const make = (wrap: (name: string, transport: StoreTransport) => StoreTransport = (_n, t) => t) => {
  const engines = new Map<string, SqlDocumentEngine>();
  let id = 0;
  const store = new ShardedStore({ transport: name => {
    if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver()));
    return wrap(name, localTransport(engines.get(name)!));
  } }, () => `doc${++id}`);
  return { store, engines };
};

it('routes site, organization and global paths to their objects', () => {
  expect(shardFor('organizations/o/sites/s/versions/main/pages/p')).toEqual({ kind: 'site', org: 'o', site: 's' });
  expect(shardFor('organizations/o/sites/s')).toEqual({ kind: 'site', org: 'o', site: 's' });
  expect(shardFor('organizations/o/members/u')).toEqual({ kind: 'org', org: 'o' });
  expect(shardFor('organizations/o/sites')).toEqual({ kind: 'org', org: 'o' });
  expect(shardFor('api_key_lookup/k')).toEqual({ kind: 'global' });
});

it('keeps site data in a uid-named object and lists sites from the organization', async () => {
  const { store, engines } = make();
  await store.setDoc('organizations/o/sites/s', { name: 'Site' });
  await store.setDoc('organizations/o/sites/s/versions/main/pages/p', { title: 'Home' });
  const uid = await store.siteUid('o', 's');
  expect(engines.has(`site:${uid}`)).toBe(true);
  expect(engines.get(`site:${uid}`)!.get('organizations/o/sites/s/versions/main/pages/p')).not.toBeNull();
  expect(engines.get('org:o')!.get('organizations/o/sites/s/versions/main/pages/p')).toBeNull();
  expect(await store.listDocs('organizations/o/sites')).toEqual([{ id: 's', name: 'Site' }]);
  await store.updateDoc('organizations/o/sites/s', { name: 'Renamed' });
  expect(await store.listDocs('organizations/o/sites')).toEqual([{ id: 's', name: 'Renamed' }]);
  await store.deleteDoc('organizations/o/sites/s');
  expect(await store.listDocs('organizations/o/sites')).toEqual([]);
});

it('moves a site to another organization by its ownership row, without copying its data', async () => {
  const { store } = make();
  await store.setDoc('organizations/a/sites/s/versions/main/pages/p', { title: 'Home' });
  const uid = await store.siteUid('a', 's');
  // The transfer itself: the new owner row points at the same object.
  await store.setDoc(ownerPath('b', 's'), { uid, org: 'b', site: 's' });
  expect(await store.siteUid('b', 's')).toBe(uid);
});

it('refuses a guard on another object instead of pretending it is atomic', async () => {
  const { store } = make();
  await store.setDoc('organizations/o/sites/s/mail_deliveries/d', { state: 'new' });
  const current = await store.getDoc('organizations/o/sites/s/mail_deliveries/d');
  await expect(store.compareAndReplaceDoc('organizations/o/sites/s/mail_deliveries/d', current, { state: 'sent' },
    [{ path: 'mail_delivery_routes/r', data: {}, expected: null }])).rejects.toThrow(/cannot be atomic/);
  expect(await store.compareAndReplaceDoc('organizations/o/sites/s/mail_deliveries/d', current, { state: 'sent' },
    [{ path: 'mail_delivery_routes/r', data: { site: 's' }, replace: true }])).toBe(true);
  expect(await store.getDoc('mail_delivery_routes/r')).toEqual({ id: 'r', site: 's' });
});

it('mirrors a site document changed by a merge effect, exactly', async () => {
  const { store } = make();
  await store.setDoc('organizations/o/sites/s', { name: 'Site', pending: null });
  await store.setDoc('organizations/o/sites/s/versions/main/pages/p', { status: 'draft' });
  const page = await store.getDoc('organizations/o/sites/s/versions/main/pages/p');
  expect(await store.compareAndReplaceDoc('organizations/o/sites/s/versions/main/pages/p', page, { status: 'published' },
    [{ path: 'organizations/o/sites/s', data: { pending: 'now' } }])).toBe(true);
  expect(await store.getDoc('organizations/o/sites/s')).toEqual({ id: 's', name: 'Site', pending: 'now' });
  expect(await store.listDocs('organizations/o/sites')).toEqual([{ id: 's', name: 'Site', pending: 'now' }]);
});

it('re-applies an outbox entry left behind by a crash', async () => {
  let fail = true;
  const { store } = make((name, transport) => name !== 'org:o' ? transport : { ...transport,
    commit: async (...args) => { if (fail) throw new Error('object unavailable'); return transport.commit(...args); } });
  await expect(store.setDoc('organizations/o/sites/s', { name: 'Site' })).rejects.toThrow('object unavailable');
  expect(await store.getDoc('organizations/o/sites/s')).toEqual({ id: 's', name: 'Site' });
  fail = false;
  expect(await store.drainOutbox(await store.shardName('organizations/o/sites/s'))).toBe(1);
  expect(await store.listDocs('organizations/o/sites')).toEqual([{ id: 's', name: 'Site' }]);
});
