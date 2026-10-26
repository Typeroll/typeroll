// In-memory sliding-window rate limiter.
//
// Keyed by an arbitrary string (typically "<endpoint>:<ip>"). Suitable for a
// single-process portal — for horizontally-scaled deployments, this needs
// to move to a shared store (Redis or Firestore w/ TTL).
//
// The limiter uses fixed windows (cheap; one Map entry per key). When a key's
// window expires the count resets. Periodic GC sweeps expired entries so
// memory doesn't grow unbounded under attack.

import { authClientAddress } from './auth-request';

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

/**
 * The caller's address for rate limiting and audit records.
 *
 * The leftmost X-Forwarded-For entry (and X-Real-IP) is whatever the client
 * sent, so trusting it lets every request pick a fresh rate-limit bucket.
 * This uses the deployment's trusted proxy hop count (AUTH_TRUST_PROXY_HOPS,
 * see authClientAddress): the address the outermost trusted proxy appended.
 * Without configured hops it falls back to the adapter's socket address,
 * which behind an unconfigured proxy is shared by all visitors.
 */
export function clientIp(headers: Headers, socketAddress?: string): string {
  return authClientAddress({ headers } as Request, socketAddress || 'unknown');
}
