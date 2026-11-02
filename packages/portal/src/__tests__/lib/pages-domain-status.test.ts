import { expect, it, vi } from 'vitest';
import { hostPointsAtProject, observePagesDomain, pagesDomainIssue, PAGES_RETRY_INTERVAL_MS } from '../../lib/publishing/pages-domain-status';
import { previousHostSaasCheck } from '../../lib/publishing/host-checks';
import { ProviderError, ProviderTransportError } from '../../lib/publishing/providers.mjs';

const project = 'typeroll-83801dedcaff3704';
const route = `/accounts/account/pages/projects/${project}/domains/moveria.ch`;
const now = Date.parse('2026-11-02T09:00:00.000Z');
const input = { accountId: 'account', project, host: 'moveria.ch', now, dnsPointsAtProject: async () => true };

function provider(domain: unknown, after: unknown = { status: 'pending' }) {
  return vi.fn(async (path: string, options?: { method?: string }) => {
    if (path !== route) throw new Error(`unexpected ${path}`);
    if (options?.method === 'PATCH') return after;
    if (domain instanceof Error) throw domain;
    return domain;
  });
}

it('reads an active domain without writing', async () => {
  const cf = provider({ status: 'active', validation_data: { method: 'http', status: 'active' } });
  expect(await observePagesDomain(cf, input)).toMatchObject({ status: 'active', retry: null, retried_at: null });
  expect(cf.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  expect(pagesDomainIssue({ host: 'moveria.ch', status: 'active' } as any)).toBeNull();
});

it('retries a deactivated domain with Cloudflare\'s PATCH once the host points at the project', async () => {
  const cf = provider({ status: 'deactivated', validation_data: { method: 'http', status: 'deactivated' }, verification_data: { error_message: 'CNAME record not set' } });
  const observed = await observePagesDomain(cf, input);
  expect(cf).toHaveBeenCalledWith(route, { method: 'PATCH', body: {} });
  expect(observed).toMatchObject({ status: 'pending', retry: 'requested', retried_at: new Date(now).toISOString(), dns_points_at_project: true });
});

it('rate-limits retries unless forced and never retries while DNS points elsewhere', async () => {
  const deactivated = { status: 'deactivated' };
  const recent = new Date(now - PAGES_RETRY_INTERVAL_MS + 1000).toISOString();
  const cf = provider(deactivated);
  expect(await observePagesDomain(cf, { ...input, lastRetryAt: recent })).toMatchObject({ status: 'deactivated', retry: 'rate_limited', retried_at: recent });
  expect(await observePagesDomain(cf, { ...input, dnsPointsAtProject: async () => false })).toMatchObject({ retry: 'dns_not_pointing', dns_points_at_project: false });
  expect(await observePagesDomain(cf, { ...input, dnsPointsAtProject: async () => null })).toMatchObject({ retry: 'dns_not_pointing' });
  expect(cf.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  expect(await observePagesDomain(cf, { ...input, lastRetryAt: recent, force: true })).toMatchObject({ retry: 'requested' });
});

it('treats provider errors as inconclusive and keeps the observed status when only the retry fails', async () => {
  for (const error of [new ProviderError('Cloudflare', 503), new ProviderError('Cloudflare', 403), new ProviderTransportError('Cloudflare')]) {
    expect(await observePagesDomain(provider(error), input)).toMatchObject({ status: null, error: expect.any(String) });
  }
  const failing = vi.fn(async (_path: string, options?: { method?: string }) => { if (options?.method) throw new ProviderError('Cloudflare', 500); return { status: 'pending' }; });
  expect(await observePagesDomain(failing, input)).toMatchObject({ status: 'pending', retry: 'failed', retried_at: null });
  await expect(observePagesDomain(provider(new TypeError('bug')), input)).rejects.toThrow('bug');
});

it('reports a missing domain and does not retry it', async () => {
  const cf = provider(null);
  const observed = await observePagesDomain(cf, input);
  expect(observed).toMatchObject({ status: 'missing', retry: null });
  expect(pagesDomainIssue(observed, project)).toMatchObject({ code: 'pages_domain_not_active', status: 'missing', retryable: false });
});

it('explains a deactivated domain with the remedy and retry path', () => {
  const issue = pagesDomainIssue({ host: 'moveria.ch', status: 'deactivated', error_message: null } as any, project)!;
  expect(issue).toMatchObject({ code: 'pages_domain_not_active', status: 'deactivated', retryable: true });
  expect(issue.message).toContain('HTTP 522');
  expect(issue.remedy).toContain(`moveria.ch → ${project}.pages.dev`);
  expect(issue.remedy).toContain('retry_validation');
  expect(pagesDomainIssue({ host: 'moveria.ch', status: 'blocked' } as any)).toMatchObject({ retryable: false });
});

it('decides whether DNS points at the project from the zone or public DNS', async () => {
  const zone = (records: unknown[]) => ({ provider: vi.fn(async () => records), zoneId: 'zone' });
  const cname = { type: 'CNAME', name: 'moveria.ch', content: `${project}.pages.dev`, proxied: true };
  expect(await hostPointsAtProject({ host: 'moveria.ch', project, zone: zone([cname]) })).toBe(true);
  expect(await hostPointsAtProject({ host: 'moveria.ch', project, zone: zone([{ ...cname, content: 'moveria.kinsta.cloud' }]) })).toBe(false);
  expect(await hostPointsAtProject({ host: 'moveria.ch', project, zone: zone([cname, { type: 'A', content: '192.0.2.1' }]) })).toBe(false);
  expect(await hostPointsAtProject({ host: 'www.moveria.ch', project, resolveCname: async () => [`${project}.pages.dev.`] })).toBe(true);
  // A flattened or proxied external record is not evidence either way.
  expect(await hostPointsAtProject({ host: 'www.moveria.ch', project, resolveCname: async () => { throw new Error('ENODATA'); } })).toBeNull();
});

it('warns before a switch when a Cloudflare for SaaS host still answers the website host', async () => {
  const kinsta = (async () => new Response(null, { status: 200, headers: { 'x-kinsta-cache': 'HIT' } })) as unknown as typeof fetch;
  const warning = await previousHostSaasCheck('moveria.ch', kinsta);
  expect(warning).toMatchObject({ code: 'previous_host_saas_hostname', severity: 'warning', host: 'moveria.ch', provider: { provider: 'kinsta', cloudflare_for_saas: true } });
  expect(warning!.message).toContain('right before or right after approving the switch');
  expect(warning!.message).toContain('MyKinsta → Domains');
  const typeroll = (async () => new Response(null, { headers: { 'x-typeroll-publication': 'publication' } })) as unknown as typeof fetch;
  expect(await previousHostSaasCheck('moveria.ch', typeroll)).toBeNull();
  const wix = (async () => new Response(null, { headers: { 'x-wix-request-id': '1' } })) as unknown as typeof fetch;
  expect(await previousHostSaasCheck('moveria.ch', wix)).toBeNull();
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  expect(await previousHostSaasCheck('moveria.ch', down)).toBeNull();
});
