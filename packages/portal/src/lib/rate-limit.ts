// In-memory sliding-window rate limiter.
//
// Keyed by an arbitrary string (typically "<endpoint>:<ip>"). Suitable for a
// single-process portal — for horizontally-scaled deployments, this needs
// to move to a shared store (Redis or Firestore w/ TTL).
//
// The limiter uses fixed windows (cheap; one Map entry per key). When a key's
// window expires the count resets. Periodic GC sweeps expired entries so
// memory doesn't grow unbounded under attack.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

let lastGc = Date.now();
const GC_INTERVAL_MS = 60_000;

function gcIfDue(now: number): void {
  if (now - lastGc < GC_INTERVAL_MS) return;
  lastGc = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  gcIfDue(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

/** Get the caller's IP from common reverse-proxy headers, falling back to the request URL host. */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    // First entry is the original client; subsequent are intermediate proxies.
    return forwarded.split(',')[0].trim();
  }
  return headers.get('x-real-ip') ?? 'unknown';
}
