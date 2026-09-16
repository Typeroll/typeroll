import { describe, expect, it, vi } from 'vitest';
const guard = vi.hoisted(() => vi.fn());
const documentation = vi.hoisted(() => vi.fn().mockResolvedValue({ apps: [], extensions: [] }));
vi.mock('../../lib/api-auth', () => ({ requireApiKey: guard, apiResponse: (_ctx: unknown, body: unknown) => Response.json(body) }));
vi.mock('../../lib/apps/documentation', () => ({ siteAppDocumentation: documentation }));
import { GET } from '../../pages/api/v1/sites/[siteId]/apps/documentation';

describe('documentation access boundary', () => {
  it('requires authentication and uses the authorized owner and site, including read-only shares', async () => {
    const request = new Request('https://cms.example/api/v1/sites/requested/apps/documentation');
    guard.mockResolvedValueOnce({ ok: false, response: new Response('Denied', { status: 403 }) });
    expect((await GET({ request, params: { siteId: 'requested' } } as never)).status).toBe(403);
    expect(documentation).not.toHaveBeenCalled();
    guard.mockResolvedValueOnce({ ok: true, value: { orgId: 'owner', siteId: 'authorized', permission: 'read' } });
    expect((await GET({ request, params: { siteId: 'requested' } } as never)).status).toBe(200);
    expect(documentation).toHaveBeenCalledWith('owner', 'authorized');
  });
});
