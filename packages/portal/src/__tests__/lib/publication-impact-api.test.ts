import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ guard: vi.fn(), preview: vi.fn() }));
vi.mock('../../lib/api-auth', () => ({ requireApiKey: mocks.guard, apiResponse: (_: unknown, value: unknown) => Response.json(value), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('../../lib/publishing/impact-preview', () => ({ previewPublicationImpact: mocks.preview }));
import { GET } from '../../pages/api/v1/sites/[siteId]/publishing/impact';
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue({ ok: true, value: { orgId: 'owner', siteId: 'site', versionId: 'branch' } }); mocks.preview.mockResolvedValue({ comparison: 'verified_snapshot', total: 1, provisional: true, execution: 'full', reuse_verified: false }); });
const call = (query = '?version=branch') => GET({ request: new Request(`https://portal.example/api/v1/sites/site/publishing/impact${query}`), url: new URL(`https://portal.example/api/v1/sites/site/publishing/impact${query}`), params: { siteId: 'site' } } as any) as Promise<Response>;
it('uses the authorized owning organization and selected version', async () => {
  expect(await (await call()).json()).toMatchObject({ version_id: 'branch', total: 1, execution: 'full' });
  expect(mocks.preview).toHaveBeenCalledWith('owner', 'site', 'branch');
});
it('does not read source when the caller lacks site access', async () => {
  mocks.guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 404 }) });
  expect((await call()).status).toBe(404); expect(mocks.preview).not.toHaveBeenCalled();
});
it('never silently compares main when an explicitly requested version is unavailable', async () => {
  expect((await call('?version=missing')).status).toBe(404); expect(mocks.preview).not.toHaveBeenCalled();
});
it('does not reflect internal source data from a comparison failure', async () => {
  mocks.preview.mockRejectedValue(Error('private source payload'));
  const response = await call(); expect(response.status).toBe(409); expect(await response.text()).not.toContain('private source');
});
