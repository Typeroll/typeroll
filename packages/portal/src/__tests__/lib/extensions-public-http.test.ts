import { afterEach, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { assertPublicDestination, parsePublicHttpsUrl } from '../../lib/extensions/public-http';

afterEach(() => vi.restoreAllMocks());

it.each(['https://[::1]/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[64:ff9b::a00:1]/', 'https://100.64.0.1/', 'https://metadata.google.internal/'])(
  'refuses the non-public URL %s',
  (raw) => expect(() => parsePublicHttpsUrl(raw)).toThrow(/public host/),
);

it.each(['::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', 'fe80::1'])(
  'rejects a host that resolves to %s',
  async (address) => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address, family: 6 }] as never);
    await expect(assertPublicDestination(new URL('https://rebind.example/'))).rejects.toThrow(/non-public/);
  },
);

it('checks IP literals instead of exempting them, as redirect targets reach it directly', async () => {
  const lookup = vi.spyOn(dns, 'lookup');
  await expect(assertPublicDestination(new URL('https://169.254.169.254/'))).rejects.toThrow(/non-public/);
  await expect(assertPublicDestination(new URL('https://[::ffff:a9fe:a9fe]/'))).rejects.toThrow(/non-public/);
  await expect(assertPublicDestination(new URL('https://8.8.8.8/'))).resolves.toBeUndefined();
  expect(lookup).not.toHaveBeenCalled();
});
