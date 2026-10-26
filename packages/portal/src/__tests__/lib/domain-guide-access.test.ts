import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ permission: 'admin', tokenSiteId: null as string | null, call: vi.fn(), read: vi.fn(), onboard: vi.fn() }));
vi.mock('../../lib/api-auth', () => ({
  requireApiKey: async () => ({ ok: true, value: { orgId: 'owner', siteId: 'site', permission: mocks.permission } }),
  requireAnyApiKey: async () => ({ ok: true, value: { tokenOrgId: 'owner', tokenSiteId: mocks.tokenSiteId, permission: mocks.permission } }),
  apiResponse: (_: unknown, data: unknown) => Response.json(data), apiError: (error: string, status: number) => Response.json({ error }, { status }),
}));
vi.mock('../../lib/publishing/domain-guide', () => ({ domainGuideAction: mocks.call, readDomainGuide: mocks.read }));
vi.mock('../../lib/publishing/domain-zone-onboarding', () => ({ onboardDomainZone: mocks.onboard }));
import { POST, GET } from '../../pages/api/v1/sites/[siteId]/publishing/domain-guide';
import { POST as onboard } from '../../pages/api/v1/publishing/domain-onboarding';
beforeEach(() => { vi.clearAllMocks(); mocks.permission = 'admin'; mocks.tokenSiteId = null; mocks.call.mockResolvedValue({ ok: true }); mocks.read.mockResolvedValue({ state: 'ready_to_switch' }); mocks.onboard.mockResolvedValue({ state: 'review' }); });
const context = (body?: unknown) => ({ params: { siteId: 'site' }, request: new Request('https://cms.example.com/api/v1/sites/site/publishing/domain-guide', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }) as any;
it.each(['read', 'write'])('denies domain writes to %s site access before invoking the action', async permission => {
  mocks.permission = permission;
  expect((await POST(context({ action: 'approve', candidate_id: 'candidate', revision: 'revision' }))).status).toBe(403);
  expect(mocks.call).not.toHaveBeenCalled();
});
it('forwards admin actions under the resolved owner and reads do not execute an action', async () => {
  expect((await GET(context())).status).toBe(200); expect(mocks.call).not.toHaveBeenCalled();
  const body = { action: 'rollback', candidate_id: 'candidate', revision: 'revision' };
  expect((await POST(context(body))).status).toBe(200);
  expect(mocks.call).toHaveBeenCalledWith('owner', 'site', body);
});
it('does not let a site key create or import an organization DNS zone', async () => {
  mocks.tokenSiteId = 'site';
  expect((await onboard(context({ action: 'create_zone', site_id: 'site', zone_name: 'example.com' }))).status).toBe(403);
  expect(mocks.onboard).not.toHaveBeenCalled();
});
it('rejects invalid site paths before accessing an organization DNS plan', async () => {
  expect((await onboard(context({ action: 'create_zone', site_id: '../other', zone_name: 'example.com' }))).status).toBe(400);
  expect(mocks.onboard).not.toHaveBeenCalled();
});
it('forwards a valid organization-admin onboarding request', async () => {
  const body = { action: 'review_dns', site_id: 'site', zone_name: 'example.com' };
  expect((await onboard(context(body))).status).toBe(200);
  expect(mocks.onboard).toHaveBeenCalledWith('owner', 'site', body);
});
