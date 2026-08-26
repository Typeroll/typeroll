import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a! >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith('::ffff:127.');
  }
  return true;
}

export function parsePublicHttpsUrl(raw: string, label = 'URL'): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  if (url.hash) throw new Error(`${label} must not contain a fragment`);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`${label} must use a public host`);
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`${label} must use a public host`);
  return url;
}

export async function assertPublicDestination(url: URL): Promise<void> {
  if (net.isIP(url.hostname)) return;
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Destination resolved to a non-public address');
  }
}

export async function fetchPublicAsset(
  rawUrl: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const url = parsePublicHttpsUrl(rawUrl, 'Asset URL');
  await assertPublicDestination(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'Typeroll-Extension-Assets/1.0' },
    });
    if (!response.ok) throw new Error(`Asset responded with HTTP ${response.status}`);
    if (response.status >= 300 && response.status < 400) throw new Error('Asset redirects are not allowed');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`Asset exceeds ${maxBytes} bytes`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Asset exceeds ${maxBytes} bytes`);
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}
