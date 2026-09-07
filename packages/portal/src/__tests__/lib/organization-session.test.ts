import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { listOrganizations, rememberOrganization, resolveOrganizationSession, selectOrganization, clearOrganization } from '../../lib/organization-session';

const session = { userId: 'member-one', email: 'member@example.invalid', orgId: 'alpha' };
const jar = () => {
  const values = new Map<string, string>();
  return { get: (key: string) => values.has(key) ? { value: values.get(key)! } : undefined,
    set: vi.fn((key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn((key: string) => { values.delete(key); }) };
};
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  for (const [id, name, role] of [['alpha', 'Alpha Agency', 'owner'], ['beta', 'Beta Client', 'editor'], ['hidden', 'Hidden Customer', 'admin']]) {
    await getStore().setDoc(paths.org(id), { name, roles_enforced: true });
    await getStore().setDoc(`${paths.members(id)}/${id === 'hidden' ? 'someone-else' : session.userId}`, { role });
  }
});
it('discovers the legacy organization, lists distinct roles, and filters stale or forged index entries', async () => {
  await rememberOrganization(session.userId, 'beta');
  expect(await getStore().getDoc('user_organizations/member-one')).toMatchObject({ schema_version: 1 });
  await getStore().setDoc('user_organizations/member-one/organizations/hidden', { org_id: 'hidden' });
  expect(await listOrganizations(session)).toEqual([
    { id: 'alpha', name: 'Alpha Agency', role: 'owner' },
    { id: 'beta', name: 'Beta Client', role: 'editor' },
  ]);
  await getStore().deleteDoc(`${paths.members('beta')}/${session.userId}`);
  expect((await listOrganizations(session)).map(x => x.id)).toEqual(['alpha']);
});
it('switches one browser, clears version selection, and leaves another browser on its original organization', async () => {
  const one = jar(); const two = jar();
  selectOrganization(one as never, session.userId, 'beta');
  expect((await resolveOrganizationSession(one as never, session)).orgId).toBe('beta');
  expect((await resolveOrganizationSession(two as never, session)).orgId).toBe('alpha');
  expect(one.delete).toHaveBeenCalledWith('typeroll_version', { path: '/' });
  expect(one.set).toHaveBeenCalledWith('typeroll_organization', expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }));
});
it.each(['hidden', '../alpha', 'alpha/sites', '', null])('rejects untrusted organization selection %s', async (orgId) => {
  const cookies = jar(); cookies.set('typeroll_organization', JSON.stringify({ userId: session.userId, orgId }));
  expect((await resolveOrganizationSession(cookies as never, session)).orgId).toBeUndefined();
});
it('revokes a selected membership immediately and does not fall back to the legacy claim', async () => {
  const cookies = jar(); selectOrganization(cookies as never, session.userId, 'beta');
  await getStore().deleteDoc(`${paths.members('beta')}/${session.userId}`);
  expect((await resolveOrganizationSession(cookies as never, session)).orgId).toBeUndefined();
});
it('does not reuse another signed-in user’s browser selection', async () => {
  const cookies = jar(); selectOrganization(cookies as never, 'someone-else', 'hidden');
  expect((await resolveOrganizationSession(cookies as never, session)).orgId).toBe('alpha');
});
it('recovers memberships after signing in without a legacy organization claim', async () => {
  await rememberOrganization(session.userId, 'beta');
  expect((await resolveOrganizationSession(jar() as never, { ...session, orgId: undefined })).orgId).toBe('beta');
});
it('does not restore a revoked indexed legacy membership after logout', async () => {
  await rememberOrganization(session.userId, 'alpha');
  await getStore().deleteDoc(`${paths.members('alpha')}/${session.userId}`);
  expect((await resolveOrganizationSession(jar() as never, session)).orgId).toBeUndefined();
});
it('clears the browser selection and version at logout', () => {
  const cookies = jar(); selectOrganization(cookies as never, session.userId, 'beta');
  clearOrganization(cookies as never);
  expect(cookies.get('typeroll_organization')).toBeUndefined();
});
