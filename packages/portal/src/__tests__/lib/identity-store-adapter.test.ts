// The Better Auth adapter's atomic guarantees over the document store, and the
// Firebase import with sign-in rehashing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReadWriteStore } from '../../lib/datastore';
import { storeAdapter } from '../../lib/identity/store-adapter';
import { createPortalAuth, type PortalAuth } from '../../lib/identity/portal-auth';
import { importFirebaseUsers } from '../../lib/identity/firebase-import';
import { _setAccountMailSenderForTests } from '../../lib/identity/account-mail';
import { Browser, ORIGIN, memoryStore } from '../helpers/identity';

let store: ReadWriteStore;
const adapter = () => storeAdapter({ store: () => store, prefix: 'auth' })({} as never);
const now = () => new Date();

beforeEach(() => { store = memoryStore(); });

describe('identity store adapter', () => {
  it('consumes a single-use row exactly once under concurrency', async () => {
    const db = adapter();
    await db.create({ model: 'verification', data: { identifier: 'reset:abc', value: 'u1', expiresAt: now(), createdAt: now(), updatedAt: now() } });
    const results = await Promise.all(Array.from({ length: 8 }, () => db.consumeOne({ model: 'verification', where: [{ field: 'identifier', value: 'reset:abc' }] })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.findOne({ model: 'verification', where: [{ field: 'identifier', value: 'reset:abc' }] })).toBeNull();
  });

  it('applies guarded increments without losing updates or passing the guard', async () => {
    const db = storeAdapter({ store: () => store, prefix: 'auth' })({ verification: { additionalFields: { remaining: { type: 'number', required: false } } } } as never);
    const row = await db.create<{ identifier: string; value: string; expiresAt: Date; createdAt: Date; updatedAt: Date }, { id: string }>({ model: 'verification', data: { identifier: 'n', value: '0', expiresAt: now(), createdAt: now(), updatedAt: now() } });
    await store.updateDoc(`auth_verification/${row.id}`, { remaining: 5 });
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      db.incrementOne({ model: 'verification', where: [{ field: 'id', value: row.id }, { field: 'remaining', operator: 'gt', value: 0 }], increment: { remaining: -1 } })));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await store.getDoc(`auth_verification/${row.id}`)).toMatchObject({ remaining: 0 });
  });

  it('evaluates OR, insensitive and range filters', async () => {
    const db = adapter();
    for (const email of ['a@x.test', 'B@x.test', 'c@y.test']) await db.create({ model: 'user', data: { email, name: email, emailVerified: false, createdAt: now(), updatedAt: now() } });
    const found = await db.findMany<{ email: string }>({ model: 'user', where: [{ field: 'email', value: 'b@x.test', mode: 'insensitive' }, { field: 'email', operator: 'ends_with', value: '@y.test', connector: 'OR' }], sortBy: { field: 'email', direction: 'asc' } });
    expect(found.map(u => u.email)).toEqual(['B@x.test', 'c@y.test']);
    expect(await db.count({ model: 'user', where: [{ field: 'email', operator: 'contains', value: '@x.' }] })).toBe(2);
  });

  it('reuses a unique value after its row is deleted or changed', async () => {
    const db = adapter();
    const first = await db.create<Record<string, unknown>, { id: string }>({ model: 'user', data: { email: 'same@x.test', name: 'a', emailVerified: false, createdAt: now(), updatedAt: now() } });
    await expect(db.create({ model: 'user', data: { email: 'same@x.test', name: 'b', emailVerified: false, createdAt: now(), updatedAt: now() } })).rejects.toThrow(/already exists/);
    await db.update({ model: 'user', where: [{ field: 'id', value: first.id }], update: { email: 'moved@x.test' } });
    await db.create({ model: 'user', data: { email: 'same@x.test', name: 'b', emailVerified: false, createdAt: now(), updatedAt: now() } });
    await expect(db.update({ model: 'user', where: [{ field: 'id', value: first.id }], update: { email: 'same@x.test' } })).rejects.toThrow(/already exists/);
  });

  it('keeps instances with different prefixes apart', async () => {
    const portal = adapter();
    const operator = storeAdapter({ store: () => store, prefix: 'operator_auth' })({} as never);
    await portal.create({ model: 'user', data: { email: 'one@x.test', name: 'p', emailVerified: true, createdAt: now(), updatedAt: now() } });
    await operator.create({ model: 'user', data: { email: 'one@x.test', name: 'o', emailVerified: true, createdAt: now(), updatedAt: now() } });
    expect(await portal.count({ model: 'user' })).toBe(1);
    expect(await operator.count({ model: 'user' })).toBe(1);
  });
});

describe('Firebase import', () => {
  const SECRET = 'test-auth-secret-0123456789abcdef-0123456789';
  // Published example from github.com/firebase/scrypt.
  const PARAMS = { base64_signer_key: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==', base64_salt_separator: 'Bw==', rounds: 8, mem_cost: 14 };
  const exported = [
    { localId: 'FirebaseUid0000000000000001', email: 'Owner@Example.test', emailVerified: true, displayName: 'Owner', salt: '42xEC+ixf3L2lw==', passwordHash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==', createdAt: '1700000000000' },
    { localId: 'FirebaseUid0000000000000002', email: 'gh@example.test', emailVerified: true, providerUserInfo: [{ providerId: 'github.com', rawId: '4242' }] },
    { localId: 'FirebaseUid0000000000000003', email: 'off@example.test', disabled: true, salt: '42xEC+ixf3L2lw==', passwordHash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==' },
    { localId: 'FirebaseUid0000000000000004' },
  ];
  let auth: PortalAuth;
  beforeEach(() => {
    process.env.LEGACY_FIREBASE_SCRYPT = JSON.stringify(PARAMS);
    auth = createPortalAuth({ secret: SECRET, baseURL: ORIGIN, store: () => store });
    _setAccountMailSenderForTests(async () => {});
  });
  afterEach(() => { delete process.env.LEGACY_FIREBASE_SCRYPT; });

  it('keeps Firebase UIDs, imports accounts once and reports skipped users', async () => {
    const first = await importFirebaseUsers(auth, exported);
    expect(first).toMatchObject({ created: 3, existing: 0, accountsCreated: 3, skipped: [{ uid: 'FirebaseUid0000000000000004', reason: 'no email address' }] });
    expect(await store.getDoc('auth_user/FirebaseUid0000000000000001')).toMatchObject({ email: 'owner@example.test', emailVerified: true, name: 'Owner' });
    const again = await importFirebaseUsers(auth, exported);
    expect(again).toMatchObject({ created: 0, existing: 3, accountsCreated: 0 });
  });

  it('signs in with the Firebase password and rehashes it', async () => {
    await importFirebaseUsers(auth, exported);
    const browser = new Browser(auth.handler);
    const response = await browser.post('/api/auth/sign-in/email', { email: 'owner@example.test', password: 'user1password' });
    expect(response.status).toBe(200);
    expect((await response.json() as { user: { id: string } }).user.id).toBe('FirebaseUid0000000000000001');
    const [credential] = await store.listDocs<{ providerId: string; password: string }>('auth_account', { filters: [{ field: 'providerId', op: '==', value: 'credential' }, { field: 'userId', op: '==', value: 'FirebaseUid0000000000000001' }] });
    expect(credential!.password.startsWith('fbscrypt$')).toBe(false);
    // The legacy parameters are no longer needed for this person.
    delete process.env.LEGACY_FIREBASE_SCRYPT;
    expect((await new Browser(auth.handler).post('/api/auth/sign-in/email', { email: 'owner@example.test', password: 'user1password' })).status).toBe(200);
    expect((await new Browser(auth.handler).post('/api/auth/sign-in/email', { email: 'owner@example.test', password: 'user2password' })).status).toBe(401);
  });

  it('keeps a disabled Firebase user signed out', async () => {
    await importFirebaseUsers(auth, exported);
    expect((await new Browser(auth.handler).post('/api/auth/sign-in/email', { email: 'off@example.test', password: 'user1password' })).status).not.toBe(200);
  });
});
