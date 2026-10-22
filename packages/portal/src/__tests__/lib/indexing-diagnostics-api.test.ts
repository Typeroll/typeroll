import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/api-auth', () => ({ requireApiKey: vi.fn(), apiResponse: (_ctx: unknown, value: unknown) => Response.json(value), apiError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('../../lib/version-store', () => ({ vstore: { settings: vi.fn(async () => ({ sitewide_noindex: false })) } }));
vi.mock('../../lib/publishing/domain-config', () => ({ getSiteDomains: vi.fn() }));
vi.mock('../../lib/indexing-diagnostics', () => ({ diagnoseSiteIndexing: vi.fn(async () => ({ ready: true })) }));
import { requireApiKey } from '../../lib/api-auth';
import { getSiteDomains } from '../../lib/publishing/domain-config';
import { diagnoseSiteIndexing } from '../../lib/indexing-diagnostics';
import { GET } from '../../pages/api/v1/sites/[siteId]/indexing-diagnostics';

beforeEach(() => vi.clearAllMocks());
it.each([null, 'example.test'])('checks the customer publishing intent, not the generated temporary Site.domain (%s)', async websiteHost => {
  const site = { id: 'site', domain: 'site-123.sites.example.test', domain_status: 'live', publishing_mode: 'customer_git' };
  vi.mocked(requireApiKey).mockResolvedValue({ ok: true, value: { orgId: 'org', siteId: 'site', versionId: 'main', site } } as never);
  vi.mocked(getSiteDomains).mockResolvedValue({ desired: { website_host: websiteHost } } as never);
  const response = await GET({ request: new Request('https://portal.test/api/v1/sites/site/indexing-diagnostics'), params: { siteId: 'site' } } as never);
  expect(response.status).toBe(200);
  expect(getSiteDomains).toHaveBeenCalledWith('org', 'site');
  expect(diagnoseSiteIndexing).toHaveBeenCalledWith(site, { sitewide_noindex: false }, { robotsBlocked: !websiteHost });
});

it('does not read publishing settings when access is denied', async () => {
  vi.mocked(requireApiKey).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  const response = await GET({ request: new Request('https://portal.test/api/v1/sites/site/indexing-diagnostics'), params: { siteId: 'site' } } as never);
  expect(response.status).toBe(403);
  expect(getSiteDomains).not.toHaveBeenCalled();
  expect(diagnoseSiteIndexing).not.toHaveBeenCalled();
});
