import { beforeEach, expect, it, vi } from 'vitest';
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
it('does not overwrite a slug reserved by a concurrent creator', async () => {
  const spy = vi.spyOn(getStore(), 'createDocIfMissing');
  spy.mockImplementation(async (key) => key !== paths.org('collision'));
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
