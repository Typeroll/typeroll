// Hand-rolled CSRF / origin protection. Replaces Astro's built-in
// `checkOrigin` because that middleware unconditionally blocked
// bearer-authed API DELETE calls (no Origin header on a curl/MCP
// request). Logic lives here in plain TS so it's testable without
// booting Astro.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Routes that opt out because they have their own auth/anti-abuse
// protection:
//   /api/forms/submit — HMAC token + per-IP rate limit + honeypot
//   /api/analytics/events — site-bound HMAC + origin/rule validation + rate limits
//   /api/auth/session, /api/auth/dev-session — bootstrap auth; validate
//     credentials themselves and have no cookie state yet to abuse
//   /api/internal/deploy-worker — Cloud Tasks POSTs here with a Google
//     OIDC token (Bearer eyJ...) verified inside the route. Without
//     this exemption the CSRF check rejected the worker's invocation
//     and deploy jobs stayed stuck in 'queued' (the bearer doesn't
//     start with typeroll_live_ so the API-key bypass didn't apply).
const CSRF_EXEMPT_PATHS = new Set([
  '/api/forms/submit',
  '/api/analytics/events',
  '/api/auth/session',
  '/api/auth/dev-session',
  // MCP Streamable HTTP transport — Bearer-authed, not browser-driven.
  '/api/mcp',
]);

// Prefix-based exemptions. MCP endpoints (hosted-MCP transport + OAuth
// shim) are not browser-driven — they're posted to by Claude Desktop /
// claude.ai / custom connectors that authenticate via a JWT issued by
// /token, or by passing a raw typeroll_live_ key. Either way they have no
// cookie surface to abuse, so CSRF is moot. The consent form's POST
// /api/mcp/oauth/complete IS browser-driven but its Origin matches the
// portal, so it would pass the host allowlist on its own — we exempt the
// whole prefix here for clarity.
const CSRF_EXEMPT_PREFIXES = [
  '/api/mcp/',
  // Every /api/internal/ route is called by a Google service (Cloud Tasks,
  // Cloud Scheduler) with an OIDC token and NO Origin header, and each one
  // verifies that token itself — the signature IS the auth. Exempting the
  // prefix rather than listing paths is deliberate: /api/internal/deploy-worker
  // was listed individually after this exact check silently 403'd it and left
  // deploy jobs stuck in 'queued', and /api/internal/publish-sweep then hit the
  // identical wall, which is how the sweep could never have run even once a
  // scheduler job existed. A third route would have been a third occurrence.
  //
  // ⚠️ The trailing slash is load-bearing. '/api/internal' would also match
  // '/api/internal-admin/*' — the cross-tenant operator console, which IS
  // cookie-authed and browser-driven and must keep its CSRF protection.
  '/api/internal/',
];

// Hosts the portal is legitimately served on. We can't trust `url.origin`
// because Astro's Node adapter on Cloud Run falls back to "localhost"
// when constructing request.url (it ignores the X-Forwarded-Host that
// Cloud Run injects). Compare browser-sent Origin against this list
// instead — Origin is trustworthy for "the browsing context the request
// came from".
//
// PORTAL_PUBLIC_URL is appended at runtime so self-hosted deployments and
// preview branches Just Work without a code change.
const HOST_ALLOWLIST: RegExp[] = [
  /^localhost(:\d+)?$/,
  /^127\.0\.0\.1(:\d+)?$/,
  /^\[::1\](:\d+)?$/,
  /^app\.typeroll\.com$/,
  /^app\.internal-test\.typeroll\.com$/,
  // Cloud Run default hostnames; deployment terminates TLS here before
  // domain mapping is in place. `<svc>-<hash>-<region>.run.app`.
  /^[^.]+\.run\.app$/,
];

function originAllowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (HOST_ALLOWLIST.some((re) => re.test(u.host))) return true;
    const portalUrl = process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, '');
    if (portalUrl) {
      try {
        const allowedHost = new URL(portalUrl).host;
        if (u.host === allowedHost) return true;
      } catch {
        // PORTAL_PUBLIC_URL is malformed — skip silently.
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Decide whether a request should be blocked by CSRF protection.
 * Returns a 403 Response when it should be blocked, null when it should
 * be allowed through.
 *
 * Protection model:
 *  - Safe methods (GET/HEAD/OPTIONS): pass.
 *  - `Authorization: Bearer typeroll_live_*`: pass. API keys are their own
 *    CSRF protection — they're not in cookies the browser sends
 *    automatically.
 *  - Exempt paths: pass.
 *  - Otherwise: require an Origin header whose host is in the allowlist
 *    (or matches PORTAL_PUBLIC_URL). Real browsers send Origin on every
 *    state-changing fetch, so cookie-authed editor calls keep working.
 *    Non-browser clients without an API key get a structured 403
 *    pointing at the fix.
 */
export function enforceCsrf(args: { request: Request; url: URL }): Response | null {
  const { request, url } = args;
  if (SAFE_METHODS.has(request.method)) return null;
  if (CSRF_EXEMPT_PATHS.has(url.pathname)) return null;
  if (CSRF_EXEMPT_PREFIXES.some((p) => url.pathname.startsWith(p))) return null;

  const auth = request.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer typeroll_live_')) return null;

  const origin = request.headers.get('origin');
  if (origin && originAllowed(origin)) return null;

  return new Response(
    JSON.stringify({
      error: 'CSRF check failed: Origin header missing or not allowed.',
      detail: origin
        ? `Got Origin "${origin}"; the host isn't in the allowlist. Set PORTAL_PUBLIC_URL to your portal's canonical URL if this is a self-hosted deployment.`
        : `No Origin header on ${request.method} request. Browsers send this automatically; non-browser clients should authenticate with an API key (Authorization: Bearer typeroll_live_…) instead.`,
      method: request.method,
      url: url.pathname,
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}
