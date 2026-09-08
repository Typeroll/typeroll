import { expect, it, vi } from 'vitest';
import { purgePublicationHost } from '../../lib/publishing/publication-cache';
import { ProviderError } from '../../lib/publishing/providers.mjs';

it('purges only the site hostname on the independently resolved DNS account', async () => {
  const dns = vi.fn().mockResolvedValue({ id: 'purge' });
  expect(await purgePublicationHost(dns, 'dns-zone', 'site.sites2.example.com')).toBe(true);
  expect(dns).toHaveBeenCalledExactlyOnceWith('/zones/dns-zone/purge_cache', {
    method: 'POST', body: { hosts: ['site.sites2.example.com'] },
  });
});

it('defers throttled purges and explains missing consent without exposing provider details', async () => {
  const dns = vi.fn().mockRejectedValue(new ProviderError('Cloudflare', 429));
  expect(await purgePublicationHost(dns, 'zone', 'site.example.com')).toBe(false);
  dns.mockRejectedValue(new ProviderError('Cloudflare', 403));
  await expect(purgePublicationHost(dns, 'zone', 'site.example.com')).rejects.toMatchObject({ code: 'publishing_cache_access_required' });
});
