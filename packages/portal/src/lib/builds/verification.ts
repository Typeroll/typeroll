import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';
import { publicationResponse } from '../deploy/public-response';
import { assertFilePath, sha256 } from './contract.mjs';
export interface StaticObservation { route: string; expected_status: number; actual_status: number | null; reason: 'status_mismatch' | 'content_mismatch' | 'request_failed'; cf_ray: string | null }
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
  options: { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination; observe?: (result: StaticObservation) => void } = {}): Promise<boolean> {
  let actualStatus: number | null = null, ray: string | null = null;
  const failed = (reason: StaticObservation['reason']) => { options.observe?.({ route: check.route, expected_status: check.status, actual_status: actualStatus, reason, cf_ray: ray }); return false; };
  try {
    const base = parsePublicHttpsUrl(origin); let url = new URL(check.route, base);
    for (let count = 0; count < 4; count++) {
      if (url.origin !== base.origin) return failed('request_failed');
      const handle = await publicationResponse(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } }, options);
      try {
        const response = handle.response;
        actualStatus = response.status;
        const header = response.headers.get('cf-ray');
        ray = header && /^[a-f0-9]{16}-[A-Z]{3}$/.test(header) ? header : null;
        if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) return failed('request_failed'); url = new URL(location, url); continue; }
        if (check.status === 404) { await response.body?.cancel(); return response.status === 404 || failed('status_mismatch'); }
        if (response.status !== 200) { await response.body?.cancel(); return failed('status_mismatch'); }
        if (!response.body) return failed('request_failed');
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length; if (size > 25 * 1024 * 1024) return failed('content_mismatch'); chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        if (sha256(bytes) === check.sha256) return true;
        // Cloudflare can prepend its managed policy to the organization's
        // robots.txt. Still require the complete original file byte for byte;
        // this exception never applies to HTML, assets or removed routes.
        if (check.route === '/robots.txt') {
          const begin = bytes.indexOf('\n# BEGIN Cloudflare Managed content\n');
          const marker = '\n# END Cloudflare Managed Content\n\n';
          const end = bytes.indexOf(marker, begin + 1);
          if (bytes[0] === 35 && begin >= 0 && end > begin && sha256(bytes.subarray(end + marker.length)) === check.sha256) return true;
        }
        return failed('content_mismatch');
      } finally { await handle.close(); }
    }
  } catch { return failed('request_failed'); }
  return failed('request_failed');
}
