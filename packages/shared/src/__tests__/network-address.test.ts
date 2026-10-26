import { describe, expect, it } from 'vitest';
import {
  classifyIpAddress,
  isIpAddressLiteral,
  isPublicIpAddress,
  isPublicUrlHost,
  parseIpv6,
} from '../network-address.js';
import { validateExtensionManifest } from '../extensions.js';

describe('classifyIpAddress', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['100.64.0.1', 'shared'],
    ['100.127.255.255', 'shared'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link_local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.170', 'reserved'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ])('denies the IPv4 range of %s (%s)', (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '198.17.0.1', '203.0.113.1'])(
    'accepts the public IPv4 address %s',
    (address) => expect(isPublicIpAddress(address)).toBe(true),
  );

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['febf::1', 'link_local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'multicast'],
    ['100::1', 'reserved'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
  ])('denies the IPv6 address %s (%s)', (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    // IPv4-mapped, dotted and hexadecimal.
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'link_local'],
    ['::ffff:a9fe:a9fe', 'link_local'],
    ['::FFFF:A9FE:A9FE', 'link_local'],
    ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
    ['[::ffff:7f00:1]', 'loopback'],
    ['::ffff:0:a00:1', 'private'],
    // IPv4-compatible.
    ['::127.0.0.1', 'loopback'],
    ['::a9fe:a9fe', 'link_local'],
    // NAT64 well-known and local-use prefixes.
    ['64:ff9b::169.254.169.254', 'link_local'],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b:1::7f00:1', 'loopback'],
    // 6to4 embeds the IPv4 address after the 2002 prefix.
    ['2002:a9fe:a9fe::1', 'link_local'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:c0a8:0101::1', 'private'],
  ])('classifies %s by its embedded IPv4 address', (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it('keeps public embedded and global unicast IPv6 addresses public', () => {
    expect(isPublicIpAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('64:ff9b::808:808')).toBe(true);
    expect(isPublicIpAddress('2002:808:808::1')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIpAddress('[2001:4860:4860::8888]')).toBe(true);
  });

  it('treats anything that is not a strict literal as invalid, never public', () => {
    for (const value of ['', 'example.com', '1.2.3', '01.2.3.4', '256.1.1.1', '1::2::3', '12345::1', '1:2:3:4:5:6:7:8:9', '::ffff:1.2.3.999']) {
      expect(classifyIpAddress(value)).toBe('invalid');
      expect(isPublicIpAddress(value)).toBe(false);
    }
  });

  it('parses compressed IPv6 into sixteen bytes', () => {
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toHaveLength(16);
    expect(parseIpv6('1:2:3:4:5:6:7::8')).toBeNull();
  });
});

describe('isPublicUrlHost', () => {
  it('rejects local names and non-public literals, including bracketed IPv6', () => {
    for (const host of ['localhost', 'app.localhost', 'printer.local', 'metadata.google.internal', '127.0.0.2', '100.64.1.1', '[::1]', '[::ffff:a9fe:a9fe]', '[fd00::1]']) {
      expect(isPublicUrlHost(host)).toBe(false);
    }
    expect(isIpAddressLiteral('[::1]')).toBe(true);
    expect(isPublicUrlHost('extension.example.com')).toBe(true);
    expect(isPublicUrlHost('8.8.8.8')).toBe(true);
  });
});

describe('extension manifest URL policy', () => {
  it.each([
    'https://127.0.0.2/app.js',
    'https://[::1]/app.js',
    'https://100.64.0.10/app.js',
    'https://[::ffff:a9fe:a9fe]/app.js',
    'https://2130706433/app.js',
  ])('rejects the non-public support URL %s', (supportUrl) => {
    const result = validateExtensionManifest({ developer: { support_url: supportUrl } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('developer.support_url must use a public host');
  });
});
