import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';
import { publicationResponse } from '../deploy/public-response';
import { assertFilePath, sha256 } from './contract.mjs';
export interface StaticCheck { route: string; status: 200 | 404; sha256?: string }
export function staticChecks(files: Record<string, Buffer>, previous: StaticCheck[] = []): StaticCheck[] {
  const checks: StaticCheck[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    assertFilePath(name, { artifact: true });
    if (['_headers', '_redirects', '404.html'].includes(name)) continue;
    const route = '/' + (name.endsWith('.html') ? name.replace(/index\.html$/, '').replace(/\.html$/, '') : name);
    checks.push({ route, status: 200, sha256: sha256(bytes) });
  }
  const redirects = (files._redirects?.toString('utf8') ?? '').split('\n').map(line => line.trim().split(/\s+/)[0]);
  const current = new Set(checks.map(check => check.route.replace(/\/$/, '')));
  for (const check of previous) if (check.status === 200 && !current.has(check.route.replace(/\/$/, '')) && !redirects.includes(check.route)) checks.push({ route: check.route, status: 404 });
  return checks.sort((a, b) => a.route.localeCompare(b.route));
}

/** Compare actual response bytes; fresh headers cannot conceal old or deleted pages. */
export async function verifyStaticResponse(origin: string, check: StaticCheck,
  options: { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination } = {}): Promise<boolean> {
  try {
    const base = parsePublicHttpsUrl(origin); let url = new URL(check.route, base);
    for (let count = 0; count < 4; count++) {
      if (url.origin !== base.origin) return false;
      const handle = await publicationResponse(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } }, options);
      try {
        const response = handle.response;
        if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) return false; url = new URL(location, url); continue; }
        if (check.status === 404) { await response.body?.cancel(); return response.status === 404; }
        if (response.status !== 200 || !response.body) { await response.body?.cancel(); return false; }
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length; if (size > 25 * 1024 * 1024) return false; chunks.push(Buffer.from(chunk));
        }
        return sha256(Buffer.concat(chunks)) === check.sha256;
      } finally { await handle.close(); }
    }
  } catch { return false; }
  return false;
}
