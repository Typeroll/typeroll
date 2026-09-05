import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new net.BlockList();
blockedV6.addSubnet('2001::', 23, 'ipv6');
blockedV6.addSubnet('2001:db8::', 32, 'ipv6');
blockedV6.addSubnet('2002::', 16, 'ipv6');

function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) return !blockedV4.check(address, 'ipv4');
  if (net.isIPv6(address)) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

async function destination(url: URL): Promise<{ address: string; family: number }> {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Source URL must use public HTTP(S) without credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Source URL must use a public address');
  }
  const family = net.isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Source URL must use a public address');
  }
  return addresses[0]!;
}

/** Connect directly to the checked IP, keeping the original Host and TLS name. */
function requestPinned(url: URL, address: { address: string; family: number }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'GET',
      agent: false,
      signal: AbortSignal.timeout(30_000),
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Typeroll-Media-Import/1.0' },
      // Never resolve again after validation, including on dual-stack hosts.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const status = incoming.statusCode ?? 502;
      const noBody = [204, 205, 304].includes(status);
      if (noBody) incoming.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Every redirect is a fresh trust decision; fetch's automatic redirects are unsafe here. */
export async function fetchPublicSource(rawUrl: string): Promise<Response> {
  let url = new URL(rawUrl);
  for (let redirects = 0; ; redirects++) {
    const address = await destination(url);
    const response = await requestPinned(url, address);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects >= 5) throw new Error('Source URL has too many redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('Source redirect has no destination');
    url = new URL(location, url);
  }
}
