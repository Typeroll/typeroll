import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { evaluateOrganizationAccess, initialOrganizationAccess, organizationAccessPolicy, organizationRequestRefusal,
  organizationUploadTtl, requestAccessOperation, withAccessRequest } from '../../lib/organization-access';
import { requireSiteAccess, requireFullSession } from '../../lib/access';
import { requireApiKey } from '../../lib/api-auth';
import { createApiKey } from '../../lib/api-keys';
import { writeShare } from '../../lib/shares';
const policy = { initial_days: 30, read_days: 90, own_smtp: true, contact_url: 'https://example.invalid/access' };
const start = new Date('2026-01-01T00:00:00Z');
const initial = initialOrganizationAccess(policy, start)! as { schema_version: 1; initial_period: { starts_at: string; ends_at: string; read_until: string } };
const end = Date.parse(initial.initial_period.ends_at);
const req = (path: string, method = 'GET', token?: string) => new Request(`https://portal.test${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); vi.stubEnv('TYPEROLL_ORGANIZATION_ACCESS_POLICY', JSON.stringify(policy)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('organization access deadlines', () => {
  it('creates server UTC deadlines, with no policy for self hosting or retroactive trial for existing organizations', () => {
    expect(initial.initial_period).toEqual({ starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2026-01-31T00:00:00.000Z', read_until: '2026-05-01T00:00:00.000Z' });
    expect(initialOrganizationAccess(null, start)).toBeUndefined();
    expect(evaluateOrganizationAccess(initial, null, end + 1).state).toBe('unrestricted');
    expect(evaluateOrganizationAccess(undefined, policy, end + 1).can_write).toBe(true);
    expect(() => organizationAccessPolicy({ TYPEROLL_ORGANIZATION_ACCESS_POLICY: '{oops' })).toThrow();
  });
  it('locks at the exact deadline, retaining reads for exactly 90 days', () => {
    expect(evaluateOrganizationAccess(initial, policy, end - 1)).toMatchObject({ state: 'trial', can_write: true, own_smtp: true });
    expect(evaluateOrganizationAccess(initial, policy, end)).toMatchObject({ state: 'read_only', can_read: true, can_write: false });
    expect(evaluateOrganizationAccess(initial, policy, Date.parse(initial.initial_period.read_until))).toMatchObject({ state: 'expired', can_read: false, can_write: false });
  });
  it('restores paid access without altering trial dates and does not restart on pause/cancel/paid expiry', () => {
    const access = { ...initial, override: { state: 'active' as const, ends_at: null, read_until: null } };
    expect(evaluateOrganizationAccess(access, policy, end + 1)).toMatchObject({ state: 'active', can_write: true, own_smtp: false, starts_at: initial.initial_period.starts_at });
    for (const state of ['paused', 'cancelled', 'active'] as const) {
      expect(evaluateOrganizationAccess({ ...initial, override: { state, ends_at: new Date(end).toISOString(), read_until: initial.initial_period.read_until } }, policy, end)).toMatchObject({ can_read: true, can_write: false });
    }
    expect(evaluateOrganizationAccess({ ...initial, initial_period: { ...initial.initial_period, ends_at: 'invalid' } }, policy).can_read).toBe(false);
  });
  it('keeps recovery and discovery open, but never treats a preview render as an ordinary read', () => {
    for (const p of ['/api/auth/logout', '/api/mcp', '/api/orgs/switch', '/api/orgs/access', '/api/v1/access']) expect(requestAccessOperation(req(p, 'POST'))).toBeNull();
    expect(requestAccessOperation(req('/api/v1/sites'))).toBeNull();
    expect(requestAccessOperation(req('/api/v1/sites/s/export'))).toBe('read');
    expect(requestAccessOperation(req('/api/v1/sites/s/pages/batch-read', 'POST'))).toBe('read');
    expect(requestAccessOperation(req('/api/v1/sites/s/pages/p/render'), true)).toBe('preview');
    expect(requestAccessOperation(req('/api/v1/sites/s/pages', 'POST'))).toBe('write');
  });
});
describe('actual authorization boundaries', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(end);
    await getStore().setDoc(paths.org('default'), { name: 'Expired', service_access: initial });
    await getStore().setDoc(paths.site('default', 's'), { name: 'Site' });
  });
  it('rejects session writes and preview, allows read/export, and isolates concurrent request contexts', async () => {
    const cookies = { get: () => undefined } as never;
    const [read, write] = await Promise.all([
      withAccessRequest(req('/api/sites/s/pages'), () => requireSiteAccess(cookies, 's')),
      withAccessRequest(req('/api/sites/s/pages', 'POST'), () => requireSiteAccess(cookies, 's')),
    ]);
    expect(read.ok).toBe(true); expect(write.ok).toBe(false);
    const create = await withAccessRequest(req('/api/sites/create', 'POST'), () => requireFullSession(cookies));
    expect(create.ok).toBe(false);
    if (!write.ok) expect(await write.response.json()).toMatchObject({ code: 'organization_trial_ended', access: { can_read: true } });
    expect(await organizationRequestRefusal('default', req('/api/sites/s/preview'))).not.toBeNull();
    expect(await organizationRequestRefusal('default', req('/api/sites/s/export'))).toBeNull();
    vi.setSystemTime(Date.parse(initial.initial_period.read_until));
    expect(await organizationRequestRefusal('default', req('/api/sites/s/export'))).not.toBeNull();
  });
  it('enforces bearer API/MCP calls and uses the shared site owner rather than the caller organization', async () => {
    const { token } = await createApiKey({ orgId: 'default', siteId: null, name: 'test', createdBy: 'owner' });
    const denied = await requireApiKey(req('/api/v1/sites/s/pages', 'POST', token), 's');
    expect(denied.ok).toBe(false);
    await getStore().setDoc(paths.org('active'), { name: 'Existing customer' });
    await getStore().setDoc(paths.site('active', 'shared'), { name: 'Shared' });
    await writeShare({ id: 'share', site_id: 'shared', owner_org_id: 'active', shared_with_org_id: 'default', permission: 'write', created_by: 'owner', created_at: end });
    const allowed = await requireApiKey(req('/api/v1/sites/shared/pages', 'POST', token), 'shared');
    expect(allowed.ok).toBe(true);
    const unknown = await requireApiKey(req('/api/v1/sites/unknown/pages', 'POST', token), 'unknown');
    expect(unknown.ok).toBe(false); if (!unknown.ok) expect([401, 404]).toContain(unknown.response.status);
  });
  it('reads entitlement once per request without caching it across requests', async () => {
    const reads = vi.spyOn(getStore(), 'getDoc');
    await withAccessRequest(req('/api/sites/s/pages'), async () => {
      await organizationRequestRefusal('default'); await organizationRequestRefusal('default');
    });
    expect(reads.mock.calls.filter(call => call[0] === paths.org('default'))).toHaveLength(1);
    await getStore().updateDoc(paths.org('default'), { service_access: { ...initial, override: { state: 'active', ends_at: null, read_until: null } } });
    expect(await withAccessRequest(req('/api/sites/s/pages', 'POST'), () => organizationRequestRefusal('default'))).toBeNull();
    reads.mockRestore();
  });
  it('caps storage grants at expiry and refuses new grants afterwards', async () => {
    vi.setSystemTime(end - 4500);
    expect(await organizationUploadTtl('default')).toBe(4);
    vi.setSystemTime(end); await expect(organizationUploadTtl('default')).rejects.toMatchObject({ status: 403 });
    vi.unstubAllEnvs(); expect(await organizationUploadTtl('default')).toBe(300);
  });
});
