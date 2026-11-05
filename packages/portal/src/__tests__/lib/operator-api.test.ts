// The operator API module: path allowlist, conditional commits on the single
// and the sharded store, and people administration on Better Auth rows.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadWriteStore } from '../../lib/datastore';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { localTransport } from '../../lib/store/sql-store';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { ShardedStore } from '../../lib/store/sharded-store';
import { createPortalAuth } from '../../lib/identity/portal-auth';
import { createOperatorApi, documentAccess, OPERATOR_API_METHOD_NAMES, OPERATOR_API_VERSION, type OperatorApiMethods } from '../../lib/operator-api';
import { Browser, ORIGIN, memoryStore } from '../helpers/identity';

const SECRET = 'test-auth-secret-0123456789abcdef-0123456789';

function shardedStore(): ReadWriteStore {
  const engines = new Map<string, SqlDocumentEngine>();
  let id = 0;
  return new ShardedStore({ transport: name => {
    if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver()));
    return localTransport(engines.get(name)!);
  } }, () => `doc${++id}`);
}

describe('operator API surface', () => {
  it('describes its version and implements every declared method', async () => {
    const api = createOperatorApi({ store: memoryStore });
    expect(await api.describe()).toMatchObject({ api: 'typeroll-operator', version: OPERATOR_API_VERSION });
    for (const name of OPERATOR_API_METHOD_NAMES) expect(typeof api[name]).toBe('function');
  });

  it('allows only the document families the operator uses', () => {
    const can = (path: string) => [...documentAccess(path)].sort().join(',');
    expect(can('organizations/o')).toBe('read,write');
    expect(can('organizations/o/members/u')).toBe('delete,read,write');
    expect(can('organizations/o/sites/s/versions/main/pages/home')).toBe('delete,read');
    expect(can('organizations/o/sites/s/api_keys/abc')).toBe('delete,read,write');
    expect(can('operator_auth_user/u1')).toBe('delete,read,write');
    for (const refused of [
      'auth_user/u1', 'auth_session/s1', 'auth_unique/x', 'site_owners/o:s', '_outbox/x', 'scheduled_work/x',
      'organizations/o/connections/github', 'organizations/o/api_keys/k', 'typeroll_system/installation',
      'organizations/../auth_user/u1', 'operator_auth_user/../../auth_user/x', 'organizations/o/members/.',
    ]) expect(can(refused), refused).toBe('');
  });

  it('refuses identity tables and unknown families with a coded error', async () => {
    const api = createOperatorApi({ store: memoryStore });
    await expect(api.getDocument('auth_user/u1')).rejects.toThrow(/^operator_api\/forbidden_path:/);
    await expect(api.listDocuments('auth_session')).rejects.toThrow(/forbidden_path/);
    await expect(api.commit({ reads: [], writes: [{ path: 'auth_user/u1', data: { disabled: false } }] })).rejects.toThrow(/forbidden_path/);
    await expect(api.commit({ reads: [], writes: [{ path: 'organizations/o', data: null }] })).rejects.toThrow(/forbidden_path/);
    await expect(api.commit({ reads: [{ path: 'scheduled_work/x', value: null }], writes: [] })).rejects.toThrow(/forbidden_path/);
  });

  it('pages collections by document id', async () => {
    const store = memoryStore();
    for (const id of ['c', 'a', 'b']) await store.setDoc(`extension_catalog/${id}`, { status: id === 'b' ? 'published' : 'in_review' });
    const api = createOperatorApi({ store: () => store });
    const first = await api.listDocuments('extension_catalog', { limit: 2 });
    expect(first.documents.map(doc => doc.id)).toEqual(['a', 'b']);
    const second = await api.listDocuments('extension_catalog', { limit: 2, startAfterId: first.next! });
    expect(second).toEqual({ documents: [{ id: 'c', status: 'in_review' }], next: null });
    const filtered = await api.listDocuments('extension_catalog', { filters: [{ field: 'status', value: 'published' }] });
    expect(filtered.documents.map(doc => doc.id)).toEqual(['b']);
    await expect(api.listDocuments('extension_catalog', { limit: 501 })).rejects.toThrow(/invalid_request/);
  });
});

describe.each([
  ['single store', memoryStore],
  ['sharded store', shardedStore],
])('operator commits on the %s', (_name, make) => {
  let store: ReadWriteStore;
  let api: OperatorApiMethods;
  beforeEach(async () => {
    store = make();
    api = createOperatorApi({ store: () => store });
    await store.setDoc('organizations/o', { name: 'Org' });
    await store.setDoc('organizations/o/members/a', { role: 'owner' });
    await store.setDoc('organizations/o/members/b', { role: 'owner' });
    await store.setDoc('organizations/o/sites/s', { name: 'Site' });
  });

  it('writes when every read still holds and refuses stale reads', async () => {
    const org = await api.getDocument('organizations/o');
    const audit = { path: 'platform_audit/1', data: { action: 'organization' } };
    expect(await api.commit({ reads: [{ path: 'organizations/o', value: org }], writes: [{ path: 'organizations/o', data: { ...org!, name: 'Renamed' } }, audit] })).toEqual({ ok: true });
    expect(await store.getDoc('organizations/o')).toEqual({ id: 'o', name: 'Renamed' });
    expect(await store.getDoc('platform_audit/1')).toEqual({ id: '1', action: 'organization' });
    expect(await api.commit({ reads: [{ path: 'organizations/o', value: org }], writes: [{ path: 'organizations/o', data: { name: 'Stale' } }] })).toEqual({ ok: false });
    expect(await store.getDoc('organizations/o')).toEqual({ id: 'o', name: 'Renamed' });
  });

  it('creates a document only when it is absent', async () => {
    const create = () => api.commit({ reads: [{ path: 'platform_operation_locks/l', value: null }], writes: [{ path: 'platform_operation_locks/l', data: { audit_id: 'x' } }, { path: 'platform_audit/x', data: { status: 'started' } }] });
    expect(await create()).toEqual({ ok: true });
    expect(await create()).toEqual({ ok: false });
  });

  it('removes a member under the guard of the other members, with unconditional global writes', async () => {
    const [a, b] = await api.getDocuments(['organizations/o/members/a', 'organizations/o/members/b']);
    const remove = (other: typeof b) => api.commit({
      reads: [{ path: 'organizations/o/members/a', value: a }, { path: 'organizations/o/members/b', value: other }],
      writes: [
        { path: 'organizations/o/members/a', data: null },
        { path: 'user_organizations/a/organizations/o', data: { org_id: 'o' } },
        { path: 'platform_audit/2', data: { action: 'member' } },
      ],
    });
    expect(await remove({ ...b!, role: 'editor' })).toEqual({ ok: false });
    expect(await store.getDoc('organizations/o/members/a')).not.toBeNull();
    expect(await store.getDoc('platform_audit/2')).toBeNull();
    expect(await remove(b)).toEqual({ ok: true });
    expect(await store.getDoc('organizations/o/members/a')).toBeNull();
    expect(await store.getDoc('user_organizations/a/organizations/o')).toEqual({ id: 'o', org_id: 'o' });
    expect(await store.getDoc('platform_audit/2')).toEqual({ id: '2', action: 'member' });
  });

  it('lets only one of two concurrent commits delete the same document', async () => {
    await store.setDoc('operator_auth_verification/v1', { value: 'token' });
    const row = await api.getDocument('operator_auth_verification/v1');
    const consume = () => api.commit({ reads: [{ path: 'operator_auth_verification/v1', value: row }], writes: [{ path: 'operator_auth_verification/v1', data: null }] });
    const results = await Promise.all([consume(), consume()]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(await store.getDoc('operator_auth_verification/v1')).toBeNull();
  });

  it('renames a site in its own scope and keeps the organization listing current', async () => {
    const site = await api.getDocument('organizations/o/sites/s');
    expect(await api.commit({ reads: [{ path: 'organizations/o/sites/s', value: site }], writes: [{ path: 'organizations/o/sites/s', data: { ...site!, name: 'New' } }, { path: 'platform_audit/3', data: {} }] })).toEqual({ ok: true });
    expect((await api.listDocuments('organizations/o/sites')).documents).toEqual([{ id: 's', name: 'New' }]);
  });

  it('writes a site key and its global lookup together, then deletes both', async () => {
    const meta = 'organizations/o/sites/s/api_keys/abc', lookup = 'api_key_lookup/abc';
    expect(await api.commit({ reads: [], writes: [{ path: meta, data: { key_hash: 'h' } }, { path: lookup, data: { org_id: 'o', site_id: 's' } }] })).toEqual({ ok: true });
    expect(await store.getDoc(lookup)).toEqual({ id: 'abc', org_id: 'o', site_id: 's' });
    expect(await api.commit({ reads: [], writes: [{ path: lookup, data: null }, { path: meta, data: null }] })).toEqual({ ok: true });
    expect(await store.getDoc(lookup)).toBeNull();
    expect(await store.getDoc(meta)).toBeNull();
  });

  it('refuses conditions that span sites, organizations or the global collections', async () => {
    const site = await api.getDocument('organizations/o/sites/s');
    await expect(api.commit({
      reads: [{ path: 'organizations/o/sites/s', value: site }, { path: 'platform_operation_locks/l', value: null }],
      writes: [{ path: 'platform_operation_locks/l', data: {} }],
    })).rejects.toThrow(/^operator_api\/cross_scope_condition:/);
    expect(await store.getDoc('platform_operation_locks/l')).toBeNull();
  });
});

describe('operator people administration', () => {
  let store: ReadWriteStore;
  let api: OperatorApiMethods;
  const auth = () => createPortalAuth({ secret: SECRET, baseURL: ORIGIN, store: () => store });
  let clock = Date.parse('2026-11-05T10:00:00.000Z');

  async function signUp(email: string) {
    const browser = new Browser(auth().handler, `198.51.100.${email.length}`);
    expect((await browser.post('/api/auth/sign-up/email', { email, password: 'correct horse battery', name: email.split('@')[0] })).status).toBe(200);
    return browser;
  }
  const signedIn = async (browser: Browser) => (await (await browser.request('/api/auth/get-session')).json()) !== null;

  beforeEach(() => {
    store = memoryStore();
    clock = Date.now() + 1000;
    api = createOperatorApi({ store: () => store, now: () => new Date(clock) });
  });

  it('lists accounts in pages without exposing credentials', async () => {
    for (const email of ['a@example.test', 'b@example.test', 'c@example.test']) await signUp(email);
    const first = await api.listPeople({ limit: 2 });
    expect(first.people).toHaveLength(2);
    const second = await api.listPeople({ limit: 2, cursor: first.next! });
    expect(second.next).toBeNull();
    const all = [...first.people, ...second.people];
    expect(all.map(person => person.email).sort()).toEqual(['a@example.test', 'b@example.test', 'c@example.test']);
    expect(all[0]).toEqual({
      id: expect.any(String), email: expect.any(String), name: expect.any(String), emailVerified: false, disabled: false,
      createdAt: expect.any(String), lastSessionAt: expect.any(String), credentialsValidAfter: null,
    });
    await expect(api.listPeople({ cursor: '../x' })).rejects.toThrow(/invalid_request/);
  });

  it('renames under the reviewed record and refuses a stale one', async () => {
    await signUp('ada@example.test');
    const [person] = (await api.listPeople()).people;
    const renamed = await api.updatePerson({ id: person!.id, expected: person!, name: '  Ada Lovelace ' });
    expect(renamed).toMatchObject({ ok: true, person: { name: 'Ada Lovelace', disabled: false } });
    expect(await api.updatePerson({ id: person!.id, expected: person!, name: 'Again' })).toEqual({ ok: false, reason: 'conflict' });
    expect(await api.updatePerson({ id: 'missing', expected: person!, name: 'X' })).toEqual({ ok: false, reason: 'not_found' });
    await expect(api.updatePerson({ id: person!.id, expected: person!, name: 'x'.repeat(121) })).rejects.toThrow(/invalid_request/);
  });

  it('disabling ends sessions at once, refuses new sign-ins and older delegated credentials', async () => {
    const browser = await signUp('dee@example.test');
    expect(await signedIn(browser)).toBe(true);
    const person = (await api.listPeople()).people[0]!;
    const result = await api.updatePerson({ id: person.id, expected: person, disabled: true });
    expect(result).toMatchObject({ ok: true, person: { disabled: true, lastSessionAt: null, credentialsValidAfter: new Date(clock).toISOString() } });
    expect(await signedIn(browser)).toBe(false);
    expect(await store.listDocs('auth_session')).toEqual([]);
    const again = await new Browser(auth().handler).post('/api/auth/sign-in/email', { email: 'dee@example.test', password: 'correct horse battery' });
    expect(again.status).not.toBe(200);

    const enabled = await api.updatePerson({ id: person.id, expected: (result as { person: typeof person }).person, disabled: false });
    expect(enabled).toMatchObject({ ok: true, person: { disabled: false } });
    expect((await new Browser(auth().handler).post('/api/auth/sign-in/email', { email: 'dee@example.test', password: 'correct horse battery' })).status).toBe(200);
  });

  it('revokes delegated credentials without ending sessions', async () => {
    const browser = await signUp('eve@example.test');
    const person = (await api.listPeople()).people[0]!;
    const revoked = await api.revokePersonCredentials(person.id);
    expect(revoked?.credentialsValidAfter).toBe(new Date(clock).toISOString());
    // The field account-standing.ts compares with a credential's grant time.
    expect(await store.getDoc(`auth_user/${person.id}`)).toMatchObject({ credentialsValidAfter: new Date(clock).toISOString() });
    expect(await signedIn(browser)).toBe(true);
    expect(await api.revokePersonCredentials('missing')).toBeNull();
  });
});
