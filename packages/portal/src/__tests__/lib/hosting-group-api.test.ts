import { beforeEach, expect, it, vi } from 'vitest';
import { GET, POST } from '../../pages/api/v1/publishing/hosting-groups';
import { PUT as ASSIGN } from '../../pages/api/v1/sites/[siteId]/publishing/hosting-group';
import { requireAnyApiKey, requireApiKey } from '../../lib/api-auth';
import { listHostingGroups, saveHostingGroup, assignHostingGroup } from '../../lib/publishing/hosting-groups';
vi.mock('../../lib/api-auth', () => ({ requireAnyApiKey: vi.fn(), requireApiKey: vi.fn(), apiResponse: (_ctx: unknown, data: unknown) => Response.json(data), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('../../lib/publishing/hosting-groups', () => ({ listHostingGroups: vi.fn(), saveHostingGroup: vi.fn(), assignHostingGroup: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const request = () => new Request('https://cms.example.com/api/v1/publishing/hosting-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Hosting 2', sites_domain: 'sites2.example.com', dns_mode: 'automatic' }) });
it('denies site keys before reading or modifying organization Hosting Groups', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: 'site', tokenOrgId: 'org' } } as any);
  expect((await GET({ request: request() } as any)).status).toBe(403);
  expect((await POST({ request: request() } as any)).status).toBe(403);
  expect(listHostingGroups).not.toHaveBeenCalled(); expect(saveHostingGroup).not.toHaveBeenCalled();
});
it('binds group writes to the authenticated organization and disables caching', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: null, tokenOrgId: 'owner-org' } } as any);
  vi.mocked(saveHostingGroup).mockResolvedValue({ id: 'group-2' } as any);
  const response = await POST({ request: request() } as any);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(saveHostingGroup).toHaveBeenCalledWith('owner-org', expect.objectContaining({ name: 'Hosting 2' }));
});
it('denies editor permission before changing a site hosting destination', async () => {
  vi.mocked(requireApiKey).mockResolvedValue({ ok: true, value: { orgId: 'org', siteId: 'site', permission: 'editor' } } as any);
  expect((await ASSIGN({ request: request(), params: { siteId: 'site' } } as any)).status).toBe(403);
  expect(assignHostingGroup).not.toHaveBeenCalled();
});
