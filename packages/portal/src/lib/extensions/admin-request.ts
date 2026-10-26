import { safeFetch } from '../net/safe-fetch';
import { parsePublicHttpsUrl, assertPublicDestination } from './public-http';

export interface AdminRequest { page_id: string; path: string; method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown }
/** Only a relative operation below the approved release's API base is allowed. */
export function adminDestination(base: string, input: AdminRequest): URL {
  if (!input || !['GET', 'POST'].includes(input.method) || typeof input.page_id !== 'string' ||
      typeof input.path !== 'string' || !/^\/[a-zA-Z0-9_/-]+$/.test(input.path) || input.path.includes('//'))
    throw new Error('Supply a page, GET or POST, and an unencoded relative app path');
  if (input.method === 'GET' && input.body !== undefined) throw new Error('GET cannot contain a body');
  const url = parsePublicHttpsUrl(base, 'Approved app API');
  if (url.search) throw new Error('Approved app API cannot contain query parameters');
  url.pathname = `${url.pathname.replace(/\/$/, '')}${input.path}`;
  if (input.query !== undefined) {
    if (!input.query || typeof input.query !== 'object' || Array.isArray(input.query) || Object.entries(input.query).length > 30)
      throw new Error('Query must be a small string map');
    for (const [key, value] of Object.entries(input.query)) {
      if (typeof value !== 'string' || value.length > 2000 || !/^[a-zA-Z0-9_-]+$/.test(key) || /^(token|authorization|secret|t)$/i.test(key))
        throw new Error('Invalid app query parameter');
      url.searchParams.set(key, value);
    }
  }
  return url;
}
export async function requestApprovedAdmin(url: URL, input: AdminRequest, token: string, issuer: string,
  limits = { requestBytes: 262144, responseBytes: 262144 }) {
  await assertPublicDestination(url);
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (body && Buffer.byteLength(body) > limits.requestBytes) throw new Error(`App request exceeds ${limits.requestBytes / 1024} KiB`);
  // The connection is pinned to the validated address; the streamed limit below keeps its own message.
  const response = await safeFetch(url, { method: input.method, body, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Origin: issuer, 'Content-Type': 'application/json', Accept: 'application/json' } },
  { label: 'Approved app API', maxRedirects: 0, timeoutMs: 15_000, maxBytes: 2 * limits.responseBytes });
  if (response.status >= 300 && response.status < 400) throw new Error('App redirects are not allowed');
  if (Number(response.headers.get('content-length')) > limits.responseBytes) throw new Error(`App response exceeds ${limits.responseBytes / 1024} KiB`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('App returned no JSON');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    if (size > limits.responseBytes) { await reader.cancel(); throw new Error(`App response exceeds ${limits.responseBytes / 1024} KiB`); }
    chunks.push(next.value);
  }
  return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
}
