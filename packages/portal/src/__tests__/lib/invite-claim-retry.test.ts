import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
const mocks = vi.hoisted(() => ({ claims: vi.fn(), refresh: vi.fn() }));
vi.mock('../../lib/auth', () => ({
  getSession: async () => ({ userId: 'test-user', email: 'test@example.invalid' }),
  isFirebaseConfigured: () => true, refreshSessionForUser: mocks.refresh,
}));
vi.mock('../../lib/firebase-admin', () => ({ getFirebaseAdminApp: async () => ({}), isFirebaseAdminConfigured: () => false }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ setCustomUserClaims: mocks.claims }) }));
vi.mock('../../lib/runtime-config-server', () => ({ firebaseApiKey: () => 'synthetic-public-api-key' }));
import { getStore } from '../../lib/datastore';
import { generateInviteToken } from '../../lib/invite';
import { POST } from '../../pages/api/orgs/invite/join';
beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  makeTmpFixtures();
  await resetDatastore();
  await getStore().setDoc(paths.org('test-org'), { name: 'Test' });
});
afterEach(() => vi.restoreAllMocks());
async function join() {
  return await POST({ cookies: {}, request: new Request('https://portal.test/api/orgs/invite/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: generateInviteToken('test-org') }),
  }) } as never) as Response;
}
it('repairs claims after an interrupted join and refreshes the session', async () => {
  mocks.claims.mockRejectedValueOnce(new Error('Synthetic outage')).mockResolvedValue(undefined);
  expect(await (await join()).json()).toMatchObject({ claimWarning: true });
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(await (await join()).json()).toMatchObject({ ok: true, requiresReauth: false });
  expect(mocks.claims).toHaveBeenCalledTimes(2);
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it('preserves an existing member role while repairing its claims', async () => {
  const memberPath = `${paths.members('test-org')}/test-user`;
  await getStore().setDoc(memberPath, { role: 'owner', joined_at: '2025-01-01' });
  expect((await join()).status).toBe(200);
  expect(await getStore().getDoc(memberPath)).toMatchObject({ role: 'owner', joined_at: '2025-01-01' });
  expect(mocks.claims).toHaveBeenCalledWith('test-user', { org_id: 'test-org' });
});
