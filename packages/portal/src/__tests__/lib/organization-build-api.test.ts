import { beforeEach, expect, it, vi } from 'vitest';
import { GET, POST } from '../../pages/api/v1/publishing/builds';
import { requireAnyApiKey } from '../../lib/api-auth';
import { checkBuildEngine, readBuildEngine } from '../../lib/builds/cloudflare';
vi.mock('../../lib/api-auth', () => ({ requireAnyApiKey: vi.fn(), apiResponse: (_ctx: unknown, data: unknown) => Response.json(data), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('../../lib/builds/cloudflare', () => ({ checkBuildEngine: vi.fn(), readBuildEngine: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const request = () => new Request('https://cms.example.com/api/v1/publishing/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 'revision', org_id: 'foreign' }) });
it('denies site-scoped keys before accessing organization builds', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: 'site', tokenOrgId: 'org' } } as any);
  expect((await GET({ request: request() } as any)).status).toBe(403);
  expect((await POST({ request: request() } as any)).status).toBe(403);
  expect(checkBuildEngine).not.toHaveBeenCalled(); expect(readBuildEngine).not.toHaveBeenCalled();
});
it('binds build checks to the authenticated organization and disables caching', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: null, tokenOrgId: 'owner-org' } } as any);
  vi.mocked(checkBuildEngine).mockResolvedValue({ state: 'approval_required' } as any);
  const response = await POST({ request: request() } as any);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(checkBuildEngine).toHaveBeenCalledWith('owner-org', expect.objectContaining({ revision: 'revision' }));
});
