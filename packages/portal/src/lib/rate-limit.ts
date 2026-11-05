// Fixed-window rate limiter in the document store.
//
// Workers run many isolates, so a counter in memory would limit nothing. Each
// key is one document, consumed with compare-and-replace: concurrent requests
// cannot both take the last slot. Only a hash of the key is stored. Pass
// `scope` (an organization or site path) to keep the counter in that object
// instead of the global one. Storage failure fails closed.

import { createHash } from 'node:crypto';
import { getStore } from './datastore';
import { authClientAddress } from './auth-request';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Document path the counters live under, e.g. `organizations/<org>`. Default: the global object. */
  scope?: string;
}

const COLLECTION = 'rate_limits';
const ATTEMPTS = 8;
const FAILED_RETRY_MS = 5_000;

export function rateLimitPath(key: string, options: RateLimitOptions = {}): string {
  const scope = options.scope?.replace(/\/+$/, '');
  return `${scope ? `${scope}/` : ''}${COLLECTION}/${createHash('sha256').update(key).digest('hex')}`;
}

export async function rateLimit(key: string, limit: number, windowMs: number, options: RateLimitOptions = {}): Promise<RateLimitResult> {
  const path = rateLimitPath(key, options);
  try {
    const store = getStore();
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const now = Date.now();
      const current = await store.getDoc<{ count: number; reset_at: number }>(path);
      const active = !!current && current.reset_at > now;
      if (active && current!.count >= limit) return { allowed: false, remaining: 0, resetAt: current!.reset_at };
      const next = { count: active ? current!.count + 1 : 1, reset_at: active ? current!.reset_at : now + windowMs };
      if (await store.compareAndReplaceDoc(path, current, next)) {
        return { allowed: true, remaining: Math.max(0, limit - next.count), resetAt: next.reset_at };
      }
    }
    throw new Error('Rate limit storage is contended');
  } catch (error) {
    console.warn(JSON.stringify({ event: 'rate_limit_unavailable', error: error instanceof Error ? error.message : 'unknown' }));
    return { allowed: false, remaining: 0, resetAt: Date.now() + FAILED_RETRY_MS };
  }
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
