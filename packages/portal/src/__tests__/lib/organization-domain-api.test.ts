import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from '../../pages/api/v1/publishing/domains';
import { requireAnyApiKey } from '../../lib/api-auth';
import { getOrganizationDomainStatus } from '../../lib/publishing/organization-domain-status';
vi.mock('../../lib/api-auth', () => ({ requireAnyApiKey: vi.fn(), apiResponse: (_ctx: unknown, data: unknown) => Response.json(data), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('../../lib/publishing/organization-domain-status', () => ({ getOrganizationDomainStatus: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const request = new Request('https://cms.example.com/api/v1/publishing/domains');
it('denies site-scoped keys before looking up organization domain status', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: 'site', tokenOrgId: 'org' } } as any);
  const response = await GET({ request } as any);
  expect(response.status).toBe(403);
  expect(getOrganizationDomainStatus).not.toHaveBeenCalled();
});
it('returns the shared status and instructions to the correct organization with no caching', async () => {
  vi.mocked(requireAnyApiKey).mockResolvedValue({ ok: true, value: { tokenSiteId: null, tokenOrgId: 'org' } } as any);
  const expected = { sites_domain: 'sites.example.com', media_host: 'media.example.net', domain_status: { state: 'pending', steps: [{ title: 'Check DNS' }] } };
  vi.mocked(getOrganizationDomainStatus).mockResolvedValue(expected as any);
  const response = await GET({ request } as any);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual(expected);
  expect(getOrganizationDomainStatus).toHaveBeenCalledExactlyOnceWith('org');
});
