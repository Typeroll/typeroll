import dns from 'node:dns/promises';
import { isIpAddressLiteral, isLocalHostname, isPublicIpAddress } from '@typeroll/shared';

// Shared with the manifest validator and the frozen publication runner, which
// copies this file verbatim; keep its imports to Node built-ins and
// @typeroll/shared. Portal requests that should also pin the connection to the
// validated address use lib/net/safe-fetch.
function isPrivateAddress(address: string): boolean {
  return !isPublicIpAddress(address);
}

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function parsePublicHttpsUrl(raw: string, label = 'URL'): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  if (url.hash) throw new Error(`${label} must not contain a fragment`);
  const host = url.hostname.toLowerCase();
  if (isLocalHostname(host)) throw new Error(`${label} must use a public host`);
  if (isIpAddressLiteral(host) && isPrivateAddress(bareHost(host))) throw new Error(`${label} must use a public host`);
  return url;
}

export async function assertPublicDestination(url: URL): Promise<void> {
  const host = bareHost(url.hostname);
  if (isIpAddressLiteral(host)) {
    // Redirect targets reach this check without parsePublicHttpsUrl; literals are never exempt.
    if (isPrivateAddress(host)) throw new Error('Destination resolved to a non-public address');
    return;
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Destination resolved to a non-public address');
  }
}

export async function fetchPublicAsset(
  rawUrl: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<Uint8Array> {
  const url = parsePublicHttpsUrl(rawUrl, 'Asset URL');
  await assertPublicDestination(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'Typeroll-Extension-Assets/1.0', ...headers },
    });
    if (!response.ok) throw new Error(`Asset responded with HTTP ${response.status}`);
    if (response.status >= 300 && response.status < 400) throw new Error('Asset redirects are not allowed');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`Asset exceeds ${maxBytes} bytes`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Asset returned no body');
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error(`Asset exceeds ${maxBytes} bytes`); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}
