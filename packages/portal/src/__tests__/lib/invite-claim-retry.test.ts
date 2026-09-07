import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
vi.mock('../../lib/auth', () => ({
  getSession: async () => ({ userId: 'test-user', email: 'test@example.invalid', orgId: 'original' }),
}));
import { getStore } from '../../lib/datastore';
import { generateInviteToken } from '../../lib/invite';
import { POST } from '../../pages/api/orgs/invite/join';
const cookies = { set: vi.fn(), delete: vi.fn() };
beforeEach(async () => {
  vi.clearAllMocks();
  makeTmpFixtures();
  await resetDatastore();
  await getStore().setDoc(paths.org('test-org'), { name: 'Test' });
  await getStore().setDoc(paths.org('original'), { name: 'Original' });
  await getStore().setDoc(`${paths.members('original')}/test-user`, { role: 'owner' });
});
afterEach(() => vi.restoreAllMocks());
async function join() {
  return await POST({ cookies, request: new Request('https://portal.test/api/orgs/invite/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: generateInviteToken('test-org') }),
  }) } as never) as Response;
}
it('allows an existing member to join another organization and retry safely', async () => {
  expect(await (await join()).json()).toMatchObject({ ok: true, requiresReauth: false });
  expect(await (await join()).json()).toMatchObject({ ok: true, requiresReauth: false });
  expect(await getStore().getDoc(`${paths.members('original')}/test-user`)).toMatchObject({ role: 'owner' });
  expect(await getStore().getDoc(`${paths.members('test-org')}/test-user`)).toMatchObject({ role: 'editor' });
  expect(await getStore().listDocs('user_organizations/test-user/organizations')).toHaveLength(2);
  expect(cookies.set).toHaveBeenLastCalledWith('typeroll_organization', JSON.stringify({ userId: 'test-user', orgId: 'test-org' }), expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
});
it('preserves an existing member role when joining again', async () => {
  const memberPath = `${paths.members('test-org')}/test-user`;
  await getStore().setDoc(memberPath, { role: 'owner', joined_at: '2025-01-01' });
  expect((await join()).status).toBe(200);
  expect(await getStore().getDoc(memberPath)).toMatchObject({ role: 'owner', joined_at: '2025-01-01' });
});
