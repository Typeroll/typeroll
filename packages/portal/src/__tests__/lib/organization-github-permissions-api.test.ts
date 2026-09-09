import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from '../../pages/api/v1/publishing/github-permissions';
import { requireAnyApiKey } from '../../lib/api-auth';
import { checkGithubPermissions } from '../../lib/publishing/github-permissions';
vi.mock('../../lib/api-auth', () => ({ requireAnyApiKey: vi.fn(), apiResponse: (_ctx: unknown, data: unknown) => Response.json(data), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('../../lib/publishing/github-permissions', () => ({ checkGithubPermissions: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const request = () => new Request('https://cms.example.com/api/v1/publishing/github-permissions?org_id=foreign');
it('denies site-scoped keys before contacting the provider', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: 'site', tokenOrgId: 'org' } } as any);
  expect((await GET({ request: request() } as any)).status).toBe(403);
  expect(checkGithubPermissions).not.toHaveBeenCalled();
});
it('checks only the authenticated organization and disables caching', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: null, tokenOrgId: 'owner-org' } } as any);
  vi.mocked(checkGithubPermissions).mockResolvedValue({ state: 'approval_required' } as any);
  const response = await GET({ request: request() } as any);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(checkGithubPermissions).toHaveBeenCalledWith('owner-org');
});
