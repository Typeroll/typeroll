import { beforeEach, expect, it, vi } from 'vitest';
import { GET, POST } from '../../pages/api/v1/sites/[siteId]/publishing/managed-migration';
import { requireApiKey } from '../../lib/api-auth';
import { managedMigrationPlan, migrateManagedSite } from '../../lib/publishing/managed-migration';
vi.mock('../../lib/api-auth', () => ({ requireApiKey: vi.fn(), apiResponse: (_ctx: unknown, data: unknown) => Response.json(data), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('../../lib/publishing/managed-migration', () => ({ managedMigrationPlan: vi.fn(), migrateManagedSite: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const context = () => ({ request: new Request('https://cms.example.com/api/v1/sites/site/publishing/managed-migration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 'checked-plan', org_id: 'injected-org' }) }), params: { siteId: 'site' } }) as any;
it('denies unauthenticated requests before provider access', async () => {
  vi.mocked(requireApiKey).mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
  expect((await GET(context())).status).toBe(401);
  expect((await POST(context())).status).toBe(401);
  expect(managedMigrationPlan).not.toHaveBeenCalled(); expect(migrateManagedSite).not.toHaveBeenCalled();
});
it('denies editor writes and binds admin migration to the authenticated owning organization', async () => {
  vi.mocked(requireApiKey).mockResolvedValue({ ok: true, value: { orgId: 'owner-org', siteId: 'site', permission: 'editor' } } as any);
  expect((await POST(context())).status).toBe(403);
  expect(migrateManagedSite).not.toHaveBeenCalled();
  vi.mocked(requireApiKey).mockResolvedValue({ ok: true, value: { orgId: 'owner-org', siteId: 'site', permission: 'admin' } } as any);
  vi.mocked(migrateManagedSite).mockResolvedValue({ state: 'migrated', binding: null });
  expect((await POST(context())).status).toBe(200);
  expect(migrateManagedSite).toHaveBeenCalledWith('owner-org', 'site', expect.objectContaining({ revision: 'checked-plan' }));
});
