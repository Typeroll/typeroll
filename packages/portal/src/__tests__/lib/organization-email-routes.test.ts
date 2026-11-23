import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createApiKey } from '../../lib/api-keys';
import { organizationEmailCookie, organizationEmailPublicApi } from '../../lib/email/organization-email-api';

const cookies = { get: () => undefined, set: () => {}, delete: () => {} } as never;
const origin = 'https://portal.test';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-email-settings-route-crypto-key');
  await getStore().setDoc(paths.org('default'), { name: 'Synthetic', roles_enforced: false });
  await getStore().setDoc(`${paths.members('default')}/dev-user`, { role: 'owner', email: 'owner@example.test' });
  await getStore().setDoc(paths.site('default', 'site-one'), { name: 'Synthetic site' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const request = (method = 'GET', body?: unknown, token?: string) => new Request(origin + '/api/v1/organization/email', {
  method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
});
describe('Organization email owner authority', () => {
  it('lets the owner read and change explicit grants but refuses an admin even with legacy role enforcement off', async () => {
    const read = await organizationEmailCookie(request(), cookies); expect(read.status).toBe(200);
    const summary = await read.json();
    const update = await organizationEmailCookie(request('PUT', { expected_revision: summary.revision, allowed_site_ids: ['site-one'] }), cookies);
    expect(update.status).toBe(200); expect((await update.json()).allowed_site_ids).toEqual(['site-one']);
    await getStore().updateDoc(`${paths.members('default')}/dev-user`, { role: 'admin' });
    expect((await organizationEmailCookie(request(), cookies)).status).toBe(403);
  });
  it.each(['editor', 'builder', 'member', 'viewer'])('refuses %s without revealing the stored account', async role => {
    await getStore().updateDoc(`${paths.members('default')}/dev-user`, { role });
    const response = await organizationEmailCookie(request(), cookies);
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('server_token');
  });
  it('accepts an owner-issued organization API key and rechecks the issuer’s current role', async () => {
    const { token } = await createApiKey({ orgId: 'default', siteId: null, name: 'Synthetic owner automation', createdBy: 'owner@example.test' });
    expect((await organizationEmailPublicApi(request('GET', undefined, token))).status).toBe(200);
    await getStore().updateDoc(`${paths.members('default')}/dev-user`, { role: 'admin' });
    expect((await organizationEmailPublicApi(request('GET', undefined, token))).status).toBe(403);
  });
  it('does not promote an admin-issued organization key or a Site-scoped key to owner authority', async () => {
    await getStore().setDoc(`${paths.members('default')}/admin-user`, { role: 'admin', email: 'admin@example.test' });
    const admin = await createApiKey({ orgId: 'default', siteId: null, name: 'Synthetic admin', createdBy: 'admin@example.test' });
    const site = await createApiKey({ orgId: 'default', siteId: 'site-one', name: 'Synthetic site', createdBy: 'owner@example.test' });
    expect((await organizationEmailPublicApi(request('GET', undefined, admin.token))).status).toBe(403);
    expect((await organizationEmailPublicApi(request('GET', undefined, site.token))).status).toBe(403);
  });
});
