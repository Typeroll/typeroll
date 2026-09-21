import { createHash } from 'node:crypto';

export const PROBE_BYTES = 1024 * 1024;
export const PROBE_FILE_BYTES = 256 * 1024;
export const PROBE_FILES = 16;

export function staticControlsHash(controls) {
  // The marker is checked independently on every publication. Its generated
  // header changes every build without changing routing or any file bytes.
  const headers = Buffer.from(controls._headers ?? '', 'base64').toString('utf8')
    .replace(/^(\s*X-Typeroll-Publication:[ \t]*)[a-f0-9]{64}[ \t]*$/gim, '$1<publication>');
  return createHash('sha256').update(JSON.stringify({ headers, redirects: controls._redirects ?? '' })).digest('hex');
}

/** The manifest is authoritative; unchanged content is reusable only in the same verified hosting scope. */
export function changedStaticChecks(current, previous = [], reuse = false) {
  const known = new Map(previous.map(check => [check.route, check]));
  return current.filter(check => !reuse || check.status !== 200 ||
    check.route === '/.well-known/typeroll/publication.json' ||
    known.get(check.route)?.status !== 200 || known.get(check.route)?.sha256 !== check.sha256);
}

const nativeMediaVariant = route => /^(\/[^?#]+)\.v[1-9]\d*\.(?:w[1-9]\d*|original)\.([a-f0-9]{16})\.(?:avif|webp)$/.exec(route);

/** Older bounded probes may omit the unchanged source that proves retention is safe. */
export function needsMediaRetentionEvidence(checks) {
  return checks.some(check => check.status === 404 && nativeMediaVariant(check.route));
}

/** Pages may retain retired immutable bundles on the public host for a week.
 * The exact candidate still checks their absence. Public checks must continue
 * to verify all current assets, removed Pages, media and unversioned files.
 * Native media variants may remain only when the same original bytes are still
 * in the frozen artifact; deleting or replacing the source retains the check.
 */
export function publicStaticChecks(checks, current = checks) {
  const sources = new Map(current.filter(check => check.status === 200).map(check => [check.route, check.sha256]));
  const immutableBundle = route =>
    /^\/_assets\/extensions\/[a-z0-9]+(?:[.-][a-z0-9]+)+\/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(?:css|m?js)$/.test(route) ||
    /^\/_astro\/[a-zA-Z0-9._-]+[.-][a-zA-Z0-9_-]{8,}\.(?:css|m?js)$/.test(route);
  return checks.filter(check => {
    if (check.status !== 404) return true;
    if (immutableBundle(check.route)) return false;
    const variant = nativeMediaVariant(check.route), sourceHash = variant && sources.get(variant[1]);
    return !(typeof sourceHash === 'string' && /^[a-f0-9]{64}$/.test(sourceHash) && sourceHash.startsWith(variant[2]));
  });
}

/** Coordinator probes have a fixed response-byte budget, independent of library size. */
export function selectStaticProbes(checks, changed = checks) {
  const byRoute = new Map(checks.map(check => [check.route, check]));
  const preferred = ['/.well-known/typeroll/publication.json', '/', '/robots.txt', '/sitemap.xml']
    .map(route => byRoute.get(route)).filter(Boolean);
  const rest = publicStaticChecks(changed, checks).sort((a, b) => Number(b.status === 404) - Number(a.status === 404) || a.route.localeCompare(b.route));
  const selected = [], seen = new Set(); let bytes = 0;
  for (const check of [...preferred, ...rest]) {
    if (seen.has(check.route) || selected.length >= PROBE_FILES) continue;
    const size = check.status === 404 ? 0 : check.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > PROBE_FILE_BYTES || bytes + size > PROBE_BYTES) continue;
    selected.push(check); seen.add(check.route); bytes += size;
  }
  return selected;
}

/** Hash chunks as they arrive. Only robots.txt needs a small buffer for Cloudflare's managed prefix. */
export async function verifyResponseBody(response, check, limit = 25 * 1024 * 1024, observe = () => {}) {
  if (!response.body) return false;
  const hash = createHash('sha256'), robots = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; observe(chunk.length);
    if (size > limit) return false;
    hash.update(chunk);
    if (check.route === '/robots.txt' && size <= PROBE_FILE_BYTES) robots.push(Buffer.from(chunk));
  }
  if (hash.digest('hex') === check.sha256) return true;
  if (check.route !== '/robots.txt' || size > PROBE_FILE_BYTES) return false;
  const bytes = Buffer.concat(robots), begin = bytes.indexOf('\n# BEGIN Cloudflare Managed content\n');
  const marker = '\n# END Cloudflare Managed Content\n\n', end = bytes.indexOf(marker, begin + 1);
  return bytes[0] === 35 && begin >= 0 && end > begin &&
    createHash('sha256').update(bytes.subarray(end + marker.length)).digest('hex') === check.sha256;
}

/** Runs only in the trusted customer supervisor, against its frozen Cloudflare candidate. */
export async function verifyCandidateCheck(origin, check, { fetchImpl = fetch, signal, observe } = {}) {
  const base = new URL(origin); let url = new URL(check.route, base);
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev$/.test(base.hostname) || base.port || base.username || base.password || base.pathname !== '/') throw Error('invalid_verification_origin');
  for (let redirects = 0; redirects < 4; redirects++) {
    if (url.origin !== base.origin) return false;
    const response = await fetchImpl(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) return false; url = new URL(location, url); continue;
    }
    if (check.status === 404 || response.status !== 200) { await response.body?.cancel(); return response.status === check.status; }
    return verifyResponseBody(response, check, 25 * 1024 * 1024, observe);
  }
  return false;
}

export async function verifyCandidateBatch(plan, cursor, options = {}) {
  if (!Array.isArray(plan.checks) || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > plan.checks.length) throw Error('invalid_verification_cursor');
  const end = Math.min(cursor + 100, plan.checks.length);
  for (let i = cursor; i < end; i += 8) {
    const results = await Promise.allSettled(plan.checks.slice(i, Math.min(i + 8, end)).map(check => verifyCandidateCheck(plan.origin, check, options)));
    if (results.some(result => result.status !== 'fulfilled' || !result.value)) throw Error('static_verification_pending');
  }
  return { cursor: end, total: plan.checks.length };
}
