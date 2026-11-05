import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../../lib/auth', () => ({ getSession: mocks.session }));
import { getStore } from '../../lib/datastore';
import { POST as switchOrg } from '../../pages/api/orgs/switch';
import { POST as createOrg } from '../../pages/api/orgs/create';
import { GET as listOrgs } from '../../pages/api/orgs/index';
const cookies = { set: vi.fn(), delete: vi.fn() };
const session = { userId: 'existing-member', email: 'existing@example.invalid', orgId: 'original' };
const request = (body: unknown) => ({ cookies, request: new Request('https://portal.test/api/orgs/switch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}) }) as never;
beforeEach(async () => {
  vi.clearAllMocks(); makeTmpFixtures(); await resetDatastore(); mocks.session.mockResolvedValue(session);
  await getStore().setDoc(paths.org('original'), { name: 'Original' });
  await getStore().setDoc(`${paths.members('original')}/${session.userId}`, { role: 'owner' });
});
it('creates another organization with enforced roles and preserves the original membership', async () => {
  const response = await createOrg(request({ name: 'Second Client' })) as Response;
  expect(await response.json()).toMatchObject({ ok: true, orgId: 'second-client', requiresReauth: false });
  expect(await getStore().getDoc(paths.org('second-client'))).toMatchObject({ roles_enforced: true });
  expect(await getStore().getDoc(`${paths.members('original')}/${session.userId}`)).toMatchObject({ role: 'owner' });
  expect(await getStore().getDoc(`${paths.members('second-client')}/${session.userId}`)).toMatchObject({ role: 'owner' });
  expect(await getStore().listDocs('user_organizations/existing-member/organizations')).toHaveLength(2);
});
it('never gives an organization a reserved signed-token namespace as its id', async () => {
  const response = await createOrg(request({ name: 'Analytics v1' })) as Response;
  expect(await response.json()).toMatchObject({ ok: true, orgId: 'analytics-v1-org' });
  expect(await getStore().getDoc(paths.org('analytics-v1'))).toBeNull();
});
it('does not overwrite a slug reserved by a concurrent creator', async () => {
  const store = getStore();
  const original = store.compareAndReplaceDoc.bind(store);
  const spy = vi.spyOn(store, 'compareAndReplaceDoc');
  spy.mockImplementation(async (key, ...args) => key === paths.org('collision') ? false : original(key, ...args));
  expect((await createOrg(request({ name: 'Collision' })) as Response).status).toBe(409);
  expect(await getStore().getDoc(`${paths.members('collision')}/${session.userId}`)).toBeNull();
  spy.mockRestore();
});
it('switches only to an explicit current membership, even for legacy permissive organizations', async () => {
  await getStore().setDoc(paths.org('other'), { name: 'Other', roles_enforced: false });
  await getStore().setDoc('user_organizations/existing-member/organizations/other', { org_id: 'other' });
  expect((await switchOrg(request({ orgId: 'other' })) as Response).status).toBe(404);
  expect(cookies.set).not.toHaveBeenCalled();
  await getStore().setDoc(`${paths.members('other')}/${session.userId}`, { role: 'editor' });
  expect((await switchOrg(request({ orgId: 'other' })) as Response).status).toBe(200);
});
it.each([null, {}, { orgId: 12 }])('rejects malformed switch bodies %j', async (body) => {
  expect((await switchOrg(request(body)) as Response).status).toBe(400);
});
it('requires authentication and does not cache membership metadata', async () => {
  const response = await listOrgs({ cookies } as never) as Response;
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  mocks.session.mockResolvedValue(null);
  expect((await listOrgs({ cookies } as never) as Response).status).toBe(401);
  expect((await switchOrg(request({ orgId: 'original' })) as Response).status).toBe(401);
  expect((await createOrg(request({ name: 'Unauthenticated' })) as Response).status).toBe(401);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it('starts one immutable trial per creation key and ignores client dates', async () => {
  vi.stubEnv('TYPEROLL_ORGANIZATION_ACCESS_POLICY', JSON.stringify({ initial_days: 30, read_days: 90, own_smtp: true, contact_url: 'https://example.invalid' }));
  const first = await createOrg(request({ name: 'Trial customer', service_access: { ends_at: '2099-01-01' } })) as Response;
  expect(first.status).toBe(200);
  const before = await getStore().getDoc<any>(paths.org('trial-customer'));
  expect(Date.parse(before.service_access.initial_period.ends_at) - Date.parse(before.created_at)).toBe(30 * 86400000);
  // Simulate a lost response before the post-transaction bootstrap completed.
  await getStore().deleteDoc(`${paths.org('trial-customer')}/hosting_groups/default`);
  await getStore().deleteDoc('user_organizations/existing-member/organizations/trial-customer');
  const again = await createOrg(request({ name: 'Trial customer' })) as Response;
  expect(await again.json()).toMatchObject({ reused: true, orgId: 'trial-customer' });
  expect((await getStore().getDoc<any>(paths.org('trial-customer'))).service_access).toEqual(before.service_access);
  expect(await getStore().getDoc(paths.org('trial-customer-2'))).toBeNull();
  expect(await getStore().getDoc(`${paths.org('trial-customer')}/hosting_groups/default`)).toMatchObject({ name: 'Default' });
  expect(await getStore().getDoc('user_organizations/existing-member/organizations/trial-customer')).not.toBeNull();
});

describe('organization creation on the sharded store', () => {
  // The receipt (global object) and the organization (its own object) cannot
  // share a conditional commit; creation claims globally first and resumes.
  let counter = 0;
  beforeEach(async () => {
    const { ShardedStore } = await import('../../lib/store/sharded-store');
    const { SqlDocumentEngine } = await import('../../lib/store/sql-engine');
    const { localTransport } = await import('../../lib/store/sql-store');
    const { nodeSqliteDriver } = await import('../../lib/store/node-sqlite');
    const { setRuntimeStore } = await import('../../lib/datastore');
    const engines = new Map<string, InstanceType<typeof SqlDocumentEngine>>();
    const store = new ShardedStore({ transport: name => {
      if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver()));
      return localTransport(engines.get(name)!);
    } }, () => `id${++counter}`);
    setRuntimeStore(() => store);
  });
  afterEach(async () => { (await import('../../lib/datastore')).setRuntimeStore(null); });

  it('creates once, reuses on retry and resumes an interrupted claim', async () => {
    const first = await (await createOrg(request({ name: 'Sharded Client' })) as Response).json();
    expect(first).toMatchObject({ ok: true, orgId: 'sharded-client' });
    expect(await (await createOrg(request({ name: 'Sharded Client' })) as Response).json()).toMatchObject({ orgId: 'sharded-client', reused: true });

    const store = getStore();
    const original = store.compareAndReplaceDoc.bind(store);
    const spy = vi.spyOn(store, 'compareAndReplaceDoc').mockImplementation(async (key, ...args) => {
      if (key === paths.org('interrupted')) throw new Error('object unavailable');
      return original(key, ...args);
    });
    await expect(createOrg(request({ name: 'Interrupted' }))).rejects.toThrow('object unavailable');
    spy.mockRestore();
    expect(await (await createOrg(request({ name: 'Interrupted' })) as Response).json()).toMatchObject({ ok: true, orgId: 'interrupted' });
    expect(await getStore().getDoc(`${paths.members('interrupted')}/${session.userId}`)).toMatchObject({ role: 'owner' });
  });
});
