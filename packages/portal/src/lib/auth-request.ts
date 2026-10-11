import crypto from 'node:crypto';
import { getStore } from './datastore';

/** Browser credential endpoints require this exact deployment's origin. */
export function requireAuthOrigin(request: Request): Response | null {
  const expected = new URL(process.env.PORTAL_PUBLIC_URL || request.url).origin;
  if (request.headers.get('origin') === expected) return null;
  return new Response(JSON.stringify({ error: 'Open this form on the Typeroll portal and try again.' }), {
    status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Shared fixed-window limit. CAS prevents concurrent Cloud Run instances
 * from independently admitting the same budget. One reused document per key;
 * only hashes of identifiers are stored. Storage failure fails closed. */
export async function limitAuthRequest(key: string, limit = 30, windowMs = 60_000): Promise<Response | null> {
  const store = getStore();
  const path = `auth_rate_limits/${crypto.createHash('sha256').update(key).digest('hex')}`;
  const now = Date.now();
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await store.getDoc<{ count: number; reset_at: number }>(path);
      if (current && current.reset_at > now && current.count >= limit) {
        return new Response(JSON.stringify({ error: 'Too many attempts. Please wait and try again.' }), {
          status: 429, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, Math.ceil((current.reset_at - now) / 1000))) },
        });
      }
      const active = current && current.reset_at > now;
      if (await store.compareAndReplaceDoc(path, current, {
        count: active ? current.count + 1 : 1,
        reset_at: active ? current.reset_at : now + windowMs,
      })) return null;
    }
  } catch { /* Authentication must not bypass the budget when storage fails. */ }
  return new Response(JSON.stringify({ error: 'Sign-in is temporarily busy. Please try again shortly.' }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '5' },
  });
}

/** Never trust an arbitrary leftmost X-Forwarded-For value. Configure the
 * number of append-only trusted proxy hops for the deployment, otherwise
 * use the adapter's socket address (which may share a budget behind a proxy). */
export function authClientAddress(request: Request, socketAddress: string): string {
  const hops = Number(process.env.AUTH_TRUST_PROXY_HOPS || 0);
  const chain = request.headers.get('x-forwarded-for')?.split(',').map(s => s.trim()) ?? [];
  return Number.isInteger(hops) && hops > 0 && chain.length >= hops
    ? chain[chain.length - hops] : socketAddress;
}

/** Bound credential requests while reading, including chunked bodies. */
export async function readAuthBody(request: Request, maxBytes = 65_536): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Credential request too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
