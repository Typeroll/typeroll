import { verifyResponseBody } from './static-verifier.mjs';
import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';
import { publicationResponse } from '../deploy/public-response';
import { assertFilePath, sha256 } from './contract.mjs';
import { bodySampler, diagnosticHeaders, diagnosticPath, sampleMismatch, type BodySample, type ProbeRedirect } from './probe-diagnostics';
export interface StaticObservation {
  route: string; expected_status: number; actual_status: number | null;
  reason: 'status_mismatch' | 'content_mismatch' | 'request_failed'; cf_ray: string | null;
  final_path?: string; redirect_chain?: ProbeRedirect[];
  response_headers?: Record<string, string | number>; body_sample?: BodySample;
}
export interface StaticCheck { route: string; status: 200 | 404; sha256?: string; size?: number }
export function staticChecks(files: Record<string, Buffer>, previous: StaticCheck[] = []): StaticCheck[] {
  return staticManifestChecks(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes) }])), files._redirects?.toString('utf8') ?? '', previous);
}
export function staticManifestChecks(files: Record<string, { sha256: string; size?: number }>, redirectsText = '', previous: StaticCheck[] = []): StaticCheck[] {
  const checks: StaticCheck[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    assertFilePath(name, { artifact: true });
    if (['_headers', '_redirects', '404.html'].includes(name)) continue;
    const route = '/' + (name.endsWith('.html') ? name.replace(/index\.html$/, '').replace(/\.html$/, '') : name);
    checks.push({ route, status: 200, sha256: bytes.sha256, ...(bytes.size === undefined ? {} : { size: bytes.size }) });
  }
  const redirects = redirectsText.split('\n').map(line => line.trim().split(/\s+/)[0]);
  const current = new Set(checks.map(check => check.route.replace(/\/$/, '')));
  for (const check of previous) if (check.status === 200 && !current.has(check.route.replace(/\/$/, '')) && !redirects.includes(check.route)) checks.push({ route: check.route, status: 404 });
  return checks.sort((a, b) => a.route.localeCompare(b.route));
}

/** Compare actual response bytes; fresh headers cannot conceal old or deleted pages. */
export async function verifyStaticResponse(origin: string, check: StaticCheck,
  options: { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination; observe?: (result: StaticObservation) => void; maxBytes?: number; observeBytes?: (bytes: number) => void } = {}): Promise<boolean> {
  let actualStatus: number | null = null, ray: string | null = null;
  let route = '/', finalPath = '/', headers: Record<string, string | number> = {};
  let sample: ReturnType<typeof bodySampler> | undefined;
  const redirects: ProbeRedirect[] = [];
  const failed = (reason: StaticObservation['reason']) => { options.observe?.({ route, expected_status: check.status, actual_status: actualStatus, reason, cf_ray: ray,
    final_path: finalPath, redirect_chain: redirects, response_headers: headers, ...(sample ? { body_sample: sample.result() } : {}) }); return false; };
  try {
    const base = parsePublicHttpsUrl(origin); let url = new URL(check.route, base);
    route = diagnosticPath(url); finalPath = route;
    for (let count = 0; count < 4; count++) {
      if (url.origin !== base.origin) return failed('request_failed');
      finalPath = diagnosticPath(url);
      actualStatus = null; ray = null; headers = {}; sample = undefined;
      const handle = await publicationResponse(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } }, options);
      try {
        const response = handle.response;
        actualStatus = response.status;
        headers = diagnosticHeaders(response.headers);
        const header = response.headers.get('cf-ray');
        ray = header && /^[a-f0-9]{16}-[A-Z]{3}$/.test(header) ? header : null;
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location'); await response.body?.cancel(); if (!location) return failed('request_failed');
          const next = new URL(location, url), sameOrigin = next.origin === base.origin;
          redirects.push({ status: response.status, from_path: finalPath, to_path: sameOrigin ? diagnosticPath(next) : null, same_origin: sameOrigin });
          if (!sameOrigin) return failed('request_failed');
          url = next; continue;
        }
        if (check.status === 404 && response.status === 404) { await response.body?.cancel(); return true; }
        if (check.status === 404 || response.status !== 200) {
          if (options.observe) { sample = bodySampler(options.maxBytes); await sampleMismatch(response, sample, options.observeBytes); }
          else await response.body?.cancel();
          return failed('status_mismatch');
        }
        if (!response.body) return failed('request_failed');
        if (options.observe) sample = bodySampler(options.maxBytes);
        if (await verifyResponseBody(response, check, options.maxBytes, options.observeBytes, sample)) return true;
        return failed('content_mismatch');
      } finally { await handle.close(); }
    }
  } catch { return failed('request_failed'); }
  return failed('request_failed');
}
