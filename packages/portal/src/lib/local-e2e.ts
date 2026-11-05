// Local E2E mode: the Playwright suite against the built Worker in
// `wrangler dev --local` (tests/e2e/start-worker.mjs). It unlocks the signed
// persona session exchange, the development user and the fixture seeding
// route, so it must be impossible on any deployed Worker.
//
// The Worker bundle replaces NODE_ENV with "production", so the mode cannot
// key off NODE_ENV. Every condition below is required:
//   TYPEROLL_LOCAL_E2E=allow  explicit switch, written only by start-worker.mjs
//   no AUTH_SECRET            a portal with accounts never trusts E2E identities
//   STORE_JURISDICTION=none   deployed stores are always in the EU jurisdiction;
//                             only local workerd has none
//   loopback PORTAL_PUBLIC_URL  a deployed portal has a public origin

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Whether a URL is http(s) on a loopback host. */
export function isLoopbackUrl(value: string | URL | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = typeof value === 'string' ? new URL(value.trim()) : value;
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * A portal served on this machine (`wrangler dev`, the local E2E Worker). The
 * Worker build fixes NODE_ENV to production, so local-only relaxations that
 * used to key off NODE_ENV key off the portal's own loopback origin instead;
 * a deployed portal always has a public origin.
 */
export function isLoopbackPortal(env: Record<string, string | undefined> = process.env): boolean {
  return isLoopbackUrl(env.PORTAL_PUBLIC_URL);
}

export function isLocalE2EMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.TYPEROLL_LOCAL_E2E?.trim() === 'allow'
    && !env.AUTH_SECRET?.trim()
    && env.STORE_JURISDICTION?.trim() === 'none'
    && isLoopbackUrl(env.PORTAL_PUBLIC_URL);
}
