import { expect, it, vi } from 'vitest';
import { preparePagesDomain, findPublishingZone } from '../../lib/publishing/domain-provider';

it('resolves the actual zone in the selected account instead of guessing a public suffix', async () => {
  const provider = vi.fn(async route => route.includes('name=example.co.uk') ? [{ id: 'zone', name: 'example.co.uk', account: { id: 'account' }, status: 'active' }] : []);
  expect((await findPublishingZone(provider, 'account', 'images.example.co.uk')).id).toBe('zone');
  expect(provider).toHaveBeenCalledTimes(2);
});

it('prepares external DNS instructions without writing DNS and uses the selected version branch', async () => {
  const provider = vi.fn(async () => ({ status: 'pending', validation_data: { method: 'txt', txt_name: '_validate.example.com', txt_value: 'validation-proof' } }));
  const result = await preparePagesDomain(provider, { accountId: 'account', project: 'project', branch: 'version-next', hostname: 'demo.example.com', dnsMode: 'external' });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(result.requirements).toEqual([
    { phase: 'validation', type: 'TXT', name: '_validate.example.com', content: 'validation-proof', status: 'required' },
    { phase: 'traffic', type: 'CNAME', name: 'demo.example.com', content: 'version-next.project.pages.dev', proxied: true, status: 'required' },
  ]);
});

it('keeps existing traffic untouched while certificate validation is pending', async () => {
  const provider = vi.fn(async (route: string, _options?: { method?: string }) => {
    if (route.startsWith('/zones?')) return [{ id: 'zone', name: 'www.example.com', account: { id: 'account' }, status: 'active' }];
    if (route.includes('/dns_records')) return [{ id: 'existing', type: 'A', content: '192.0.2.10' }];
    return { status: 'pending' };
  });
  const result = await preparePagesDomain(provider, { accountId: 'account', project: 'project', branch: 'main', hostname: 'www.example.com', dnsMode: 'automatic' });
  expect(result.action).toBe('complete_validation');
  expect(provider.mock.calls.every(call => call.length === 1 || !call[1]?.method)).toBe(true);
});

it('rejects a changed DNS fingerprint before any traffic write', async () => {
  const { applyPreparedTraffic, trafficFingerprint } = await import('../../lib/publishing/domain-provider');
  const provider = vi.fn(async () => [{ id: 'old', type: 'A', content: '192.0.2.20' }]);
  await expect(applyPreparedTraffic(provider, {
    hostname: 'www.example.com', provider_status: 'active', certificate_ready: true,
    zone_id: 'zone', action: 'approve_cutover',
    dns_fingerprint: trafficFingerprint([{ id: 'old', type: 'A', content: '192.0.2.10' }]),
    requirements: [{ phase: 'traffic', type: 'CNAME', name: 'www.example.com', content: 'project.pages.dev', status: 'required' }],
  })).rejects.toThrow('DNS changed');
  expect(provider).toHaveBeenCalledTimes(1);
});

it('changes one reviewed address atomically without deleting existing DNS', async () => {
  const { applyPreparedTraffic, trafficFingerprint } = await import('../../lib/publishing/domain-provider');
  const records = [{ id: 'old', type: 'A', content: '192.0.2.10' }];
  const provider = vi.fn(async (_route: string, _options?: unknown) => records);
  await applyPreparedTraffic(provider, {
    hostname: 'www.example.com', provider_status: 'active', certificate_ready: true,
    zone_id: 'zone', action: 'approve_cutover', dns_fingerprint: trafficFingerprint(records),
    requirements: [{ phase: 'traffic', type: 'CNAME', name: 'www.example.com', content: 'project.pages.dev', status: 'required' }],
  });
  expect(provider).toHaveBeenLastCalledWith('/zones/zone/dns_records/old', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ type: 'CNAME', content: 'project.pages.dev' }) }));
});

it('reports the observed CNAME prevalidation conflict without changing existing traffic', async () => {
  let active = false;
  const provider = vi.fn(async (route: string, _options?: { method?: string }) => {
    if (route.startsWith('/zones?')) return [{ id: 'zone', name: 'example.com', account: { id: 'account' }, status: 'active' }];
    if (route.includes('/dns_records')) return [{ id: 'existing', type: 'CNAME', content: 'old.example.net', proxied: true }];
    return { status: active ? 'active' : 'pending', validation_data: { method: 'http' }, verification_data: { error_message: 'CNAME record not set' } };
  });
  const input = { accountId: 'account', project: 'project', branch: 'main', hostname: 'www.example.com', dnsMode: 'automatic' as const };
  expect((await preparePagesDomain(provider, input)).validation_blocker).toMatchObject({ code: 'domain_prevalidation_unavailable' });
  expect(provider.mock.calls.every(call => !call[1]?.method)).toBe(true);
  active = true;
  expect((await preparePagesDomain(provider, input)).validation_blocker).toBeNull();
});
