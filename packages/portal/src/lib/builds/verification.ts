import { verifyResponseBody } from './static-verifier.mjs';
import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';
import { publicationResponse } from '../deploy/public-response';
import { assertFilePath, sha256 } from './contract.mjs';
import { bodySampler, diagnosticHeaders, diagnosticPath, sampleMismatch, type BodySample, type ProbeRedirect } from './probe-diagnostics';
/**
 * Why a static probe failed. Transport reasons say the bytes were never fully
 * read; only status_mismatch and content_mismatch are evidence about the
 * deployment itself. request_failed is the legacy, unclassified value.
 */
export type StaticFailureReason = 'status_mismatch' | 'content_mismatch' | 'timeout' | 'connection_failed' | 'probe_byte_budget'
  | 'redirect_offsite' | 'redirect_without_location' | 'redirect_limit' | 'request_failed';
export interface StaticObservation {
  route: string; expected_status: number; actual_status: number | null;
  reason: StaticFailureReason; cf_ray: string | null;
  /** Non-secret transport code, such as UND_ERR_SOCKET or ECONNRESET; never an error message. */
  error_code?: string;
  /** Attempts made for this route; transport failures are retried. */
  attempts?: number;
  final_path?: string; redirect_chain?: ProbeRedirect[];
  response_headers?: Record<string, string | number>; body_sample?: BodySample;
}
/** Thrown by a coordinator byte counter when probes exceed their response budget. */
export class ProbeByteBudgetError extends Error {
  constructor() { super('coordinator_probe_byte_limit'); this.name = 'ProbeByteBudgetError'; }
}
export interface StaticCheck { route: string; status: 200 | 404; sha256?: string; size?: number; redirect_target?: string }
export function staticChecks(files: Record<string, Buffer>, previous: StaticCheck[] = []): StaticCheck[] {
  return staticManifestChecks(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes) }])), files._redirects?.toString('utf8') ?? '', previous);
}
export function staticManifestChecks(files: Record<string, { sha256: string; size?: number }>, redirectsText = '', previous: StaticCheck[] = []): StaticCheck[] {
  const checks: StaticCheck[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    assertFilePath(name, { artifact: true });
    // Not-found pages, including a language section's <home_path>404.html, answer missing routes.
    if (['_headers', '_redirects', '404.html'].includes(name) || name.endsWith('/404.html')) continue;
    const route = '/' + (name.endsWith('.html') ? name.replace(/index\.html$/, '').replace(/\.html$/, '') : name);
    checks.push({ route, status: 200, sha256: bytes.sha256, ...(bytes.size === undefined ? {} : { size: bytes.size }) });
  }
  const rules = redirectsText.split('\n').map(line => line.trim().split(/\s+/));
  const redirects = rules.map(rule => rule[0]);
  // A retained media URL must resolve to the exact replacement bytes, not just
  // disappear from the deletion checks because a redirect was declared.
  const assets = new Map(checks.map(check => [check.route, check]));
  for (const [from, to, status] of rules) {
    if (!['301', '302'].includes(status) || !from.startsWith('/') || from.startsWith('//') || /[*:?#]/.test(from)) continue;
    const target = assets.get(to);
    if (!target || !files[to.slice(1)] || to.endsWith('.html') || assets.has(from)) continue;
    checks.push({ ...target, route: from, redirect_target: to });
    assets.set(from, target);
  }
  const current = new Set(checks.map(check => check.route.replace(/\/$/, '')));
  for (const check of previous) if (check.status === 200 && !current.has(check.route.replace(/\/$/, '')) && !redirects.includes(check.route)) checks.push({ route: check.route, status: 404 });
  return checks.sort((a, b) => a.route.localeCompare(b.route));
}

const TRANSPORT_REASONS = new Set<StaticFailureReason>(['timeout', 'connection_failed']);
const TRANSPORT_ATTEMPTS = 3;

function transportFailure(error: unknown): { reason: StaticFailureReason; error_code?: string } {
  if (error instanceof ProbeByteBudgetError) return { reason: 'probe_byte_budget' };
  const value = error as { name?: unknown; code?: unknown; cause?: { name?: unknown; code?: unknown } } | null;
  const names = [value?.name, value?.cause?.name].filter(name => typeof name === 'string') as string[];
  const codes = [value?.code, value?.cause?.code].filter(code => typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)) as string[];
  const code = codes[0];
  if (names.some(name => name === 'TimeoutError' || name === 'AbortError') || codes.some(entry => /TIMEOUT|timed_out|timeout/i.test(entry))) {
    return { reason: 'timeout', error_code: code ?? 'TimeoutError' };
  }
  // Only recognised network failures are transport problems worth retrying;
  // anything else, such as a URL the checks refuse, stays unclassified.
  if (codes.some(entry => /^(UND_ERR_|E[A-Z]+$)/.test(entry) || ['dns_failed', 'connection_failed'].includes(entry))) {
    return { reason: 'connection_failed', error_code: code };
  }
  return { reason: 'request_failed' };
}

/**
 * Compare actual response bytes; fresh headers cannot conceal old or deleted
 * pages. Timeouts and dropped connections are retried, because they say
 * nothing about the deployment, and their bytes are returned to the budget.
 */
export async function verifyStaticResponse(origin: string, check: StaticCheck,
  options: { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination; observe?: (result: StaticObservation) => void; maxBytes?: number; observeBytes?: (bytes: number) => void; retryDelayMs?: number } = {}): Promise<boolean> {
  let last: StaticObservation | null = null;
  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt++) {
    let counted = 0;
    const observeBytes = options.observeBytes ? (bytes: number) => { counted += bytes; options.observeBytes!(bytes); } : undefined;
    const outcome = await probeStaticResponse(origin, check, { ...options, observeBytes });
    if (outcome === true) return true;
    last = { ...outcome, attempts: attempt };
    if (!TRANSPORT_REASONS.has(outcome.reason) || attempt === TRANSPORT_ATTEMPTS) break;
    if (counted && options.observeBytes) options.observeBytes(-counted);
    await new Promise(resolve => setTimeout(resolve, (options.retryDelayMs ?? 500) * attempt));
  }
  if (last) options.observe?.(last);
  return false;
}

async function probeStaticResponse(origin: string, check: StaticCheck,
  options: { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination; maxBytes?: number; observeBytes?: (bytes: number) => void; observe?: unknown }): Promise<true | StaticObservation> {
  let actualStatus: number | null = null, ray: string | null = null;
  let route = '/', finalPath = '/', headers: Record<string, string | number> = {};
  let sample: ReturnType<typeof bodySampler> | undefined;
  const redirects: ProbeRedirect[] = [];
  const diagnose = !!options.observe;
  const failed = (reason: StaticFailureReason, extra: { error_code?: string } = {}): StaticObservation => ({ route, expected_status: check.status, actual_status: actualStatus, reason, cf_ray: ray,
    ...extra, final_path: finalPath, redirect_chain: redirects, response_headers: headers, ...(sample ? { body_sample: sample.result() } : {}) });
  // A body longer than the file it should be is wrong content; stop at that
  // file's own size so a shared byte budget never blames an innocent probe.
  // Cloudflare may prepend managed content to robots.txt, which is checked separately.
  const limit = check.route !== '/robots.txt' && Number.isSafeInteger(check.size) && check.size! >= 0
    ? Math.min(options.maxBytes ?? Number.MAX_SAFE_INTEGER, check.size!) : options.maxBytes;
  try {
    const base = parsePublicHttpsUrl(origin); let url = new URL(check.route, base);
    route = diagnosticPath(url); finalPath = route;
    for (let count = 0; count < 4; count++) {
      if (url.origin !== base.origin) return failed('redirect_offsite');
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
          const location = response.headers.get('location'); await response.body?.cancel(); if (!location) return failed('redirect_without_location');
          // Browsers never send a fragment, so the next request has none either.
          const next = new URL(location, url); next.hash = '';
          const sameOrigin = next.origin === base.origin;
          redirects.push({ status: response.status, from_path: finalPath, to_path: sameOrigin ? diagnosticPath(next) : null, same_origin: sameOrigin });
          if (!sameOrigin) return failed('redirect_offsite');
          url = next; continue;
        }
        if (check.status === 404 && response.status === 404) { await response.body?.cancel(); return true; }
        if (check.status === 404 || response.status !== 200) {
          if (diagnose) { sample = bodySampler(options.maxBytes); await sampleMismatch(response, sample, options.observeBytes); }
          else await response.body?.cancel();
          return failed('status_mismatch');
        }
        if (!response.body) return failed('connection_failed');
        if (diagnose) sample = bodySampler(options.maxBytes);
        if (await verifyResponseBody(response, check, limit, options.observeBytes, sample)) return true;
        return failed('content_mismatch');
      } finally { await handle.close(); }
    }
  } catch (error) { return failed(transportFailure(error).reason, { error_code: transportFailure(error).error_code }); }
  return failed('redirect_limit');
}
