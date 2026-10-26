import { createHash } from 'node:crypto';

export const PROBE_SAMPLE_BYTES = 4096;
export interface BodySample { sha256: string; bytes: number; scope: 'complete' | 'prefix' | 'partial' }
export interface ProbeRedirect { status: number; from_path: string; to_path: string | null; same_origin: boolean }

/** Paths only: never retain URL credentials, query parameters or fragments. */
export function diagnosticPath(url: URL) { return url.pathname.slice(0, 1024); }

/** Parse an allowlist instead of persisting arbitrary provider header strings. */
export function diagnosticHeaders(headers: Headers) {
  const result: Record<string, string | number> = {};
  const type = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) && type.length <= 100) result.content_type = type;
  const directives = (headers.get('cache-control') ?? '').slice(0, 1024).split(',').map(value => value.trim().toLowerCase()).filter(value =>
    /^(public|private|no-cache|no-store|no-transform|must-revalidate|proxy-revalidate|immutable)$/.test(value) ||
    /^(max-age|s-maxage|stale-while-revalidate|stale-if-error)=\d{1,12}$/.test(value));
  if (directives.length) result.cache_control = [...new Set(directives)].join(', ').slice(0, 256);
  const cache = headers.get('cf-cache-status');
  if (cache && /^(HIT|MISS|DYNAMIC|BYPASS|EXPIRED|STALE|UPDATING|REVALIDATED|NONE|UNKNOWN)$/.test(cache)) result.cf_cache_status = cache;
  for (const name of ['age', 'content-length']) {
    const value = headers.get(name);
    if (value && /^\d{1,15}$/.test(value) && Number.isSafeInteger(Number(value))) result[name.replace('-', '_')] = Number(value);
  }
  const publication = headers.get('x-typeroll-publication');
  if (publication && /^[a-f0-9]{64}$/.test(publication)) result.publication_id = publication;
  if (headers.get('cf-mitigated') === 'challenge') result.cf_mitigated = 'challenge';
  return result;
}

/** Keep only a bounded hash state, never body text or a retained body buffer. */
export function bodySampler(limit = PROBE_SAMPLE_BYTES) {
  const hash = createHash('sha256');
  const cap = Math.max(0, Math.min(PROBE_SAMPLE_BYTES, limit));
  let bytes = 0, seen = 0, complete = false;
  return {
    chunk(value: Uint8Array) {
      seen += value.byteLength;
      const part = value.subarray(0, Math.max(0, cap - bytes));
      hash.update(part); bytes += part.byteLength;
    },
    complete() { complete = true; },
    get full() { return bytes >= cap; },
    result(): BodySample {
      return { sha256: hash.copy().digest('hex'), bytes, scope: complete && seen === bytes ? 'complete' : bytes >= cap ? 'prefix' : 'partial' };
    },
  };
}

export async function sampleMismatch(response: Response, sampler: ReturnType<typeof bodySampler>, observeBytes?: (bytes: number) => void) {
  if (!response.body) { sampler.complete(); return; }
  const reader = response.body.getReader();
  try {
    while (!sampler.full) {
      const { done, value } = await reader.read();
      if (done) { sampler.complete(); break; }
      // Account for the entire received chunk even when only its prefix is hashed.
      observeBytes?.(value.byteLength);
      sampler.chunk(value);
    }
  } catch {
    // Diagnostics must not turn a known status mismatch into success or leak errors.
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
