import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ctx: { orgId: 'org', siteId: 'site', keyPrefix: 'synthetic', permission: 'admin' } as any,
  installation: { id: 'install', status: 'enabled', extension_id: 'example.app', granted_scopes: [] } as any,
  approved: true, signed: vi.fn(() => ({ token: 'synthetic-delegation' })), request: vi.fn(async (..._args: any[]) => ({ status: 200, data: { saved: true } })) }));
vi.mock('../../lib/api-auth', () => ({ requireApiKey: async () => ({ ok: true, value: mocks.ctx }),
  apiError: (error: string, status: number) => Response.json({ error }, { status }), apiResponse: (_: unknown, data: unknown, status: number) => Response.json(data, { status }) }));
vi.mock('../../lib/datastore', () => ({ getStore: () => ({ getDoc: async () => mocks.installation }) }));
vi.mock('../../lib/extensions/native-admin', () => ({ approvedNativeAdmin: async () => mocks.approved }));
vi.mock('../../lib/extensions/resolution', () => ({ resolveExtensionVersion: async () => ({ version: { version: '2.0.0', manifest: { admin: { pages: [{ id: 'settings', native: { api_base_url: 'https://apps.example.org/v1' } }] } } } }) }));
vi.mock('../../lib/extensions/auth', () => ({ signDelegatedExtensionToken: mocks.signed, extensionIssuer: () => 'https://cms.example.org' }));
vi.mock('../../lib/extensions/admin-request', async importOriginal => ({ ...await importOriginal<object>(), requestApprovedAdmin: mocks.request }));
import { adminDestination } from '../../lib/extensions/admin-request';
import { POST } from '../../pages/api/v1/sites/[siteId]/extensions/[installationId]/admin-request';
const call = (input: object = {}) => POST({ params: { siteId: 'site', installationId: 'install' }, request: new Request('https://cms.example.org/api', { method: 'POST', body: JSON.stringify({ page_id: 'settings', path: '/admin/preferences', method: 'GET', ...input }) }) } as never);
describe('approved app administration through API', () => {
  beforeEach(() => { mocks.ctx = { orgId: 'org', siteId: 'site', keyPrefix: 'synthetic', permission: 'admin' }; mocks.approved = true; mocks.installation.status = 'enabled'; vi.clearAllMocks(); });
  it('uses the approved base and server identity without exposing the delegation', async () => {
    const response = await call({ query: { page_id: 'profile-1' } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ saved: true });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.request.mock.calls[0]?.[0]?.toString()).toBe('https://apps.example.org/v1/admin/preferences?page_id=profile-1');
    expect(mocks.signed).toHaveBeenCalledWith(expect.objectContaining({ sub: 'api-key:synthetic', installation_id: 'install', permission: 'admin' }));
  });
  it('denies nonadmins, installation delegation, disabled apps and unapproved releases', async () => {
    mocks.ctx.permission = 'write'; expect((await call()).status).toBe(403);
    mocks.ctx.permission = 'admin'; mocks.ctx.extensionIdentity = {}; expect((await call()).status).toBe(403);
    delete mocks.ctx.extensionIdentity; mocks.installation.status = 'disabled'; expect((await call()).status).toBe(404);
    mocks.installation.status = 'enabled'; mocks.approved = false; expect((await call()).status).toBe(403);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(['//evil.org', '/a/../secret', '/%2e%2e/secret', '/ok?token=x', '/ok#secret', 'https://evil.org', '/a\\b'])('rejects path escape %s', async path => {
    expect((await call({ path })).status).toBe(400); expect(mocks.signed).not.toHaveBeenCalled();
  });
  it('rejects credential parameters and nonpublic destinations', () => {
    expect(() => adminDestination('https://apps.example.org', { page_id: 'settings', method: 'GET', path: '/admin', query: { token: 'secret' } })).toThrow();
    expect(() => adminDestination('https://localhost', { page_id: 'settings', method: 'GET', path: '/admin' })).toThrow();
  });
});
