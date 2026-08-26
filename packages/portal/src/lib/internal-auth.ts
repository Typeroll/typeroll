// Google-signed OIDC verification for /api/internal/* routes. Cloud Tasks
// and Cloud Scheduler both sign their requests with a service account's
// identity token; the routes are "internal" by contract but publicly
// reachable on Cloud Run, so the signature check IS the auth.
//
// Set DEPLOY_WORKER_SKIP_AUTH=1 to bypass in local dev (curl testing).
// Never in production.

/**
 * Audiences we accept for an internal route.
 *
 * A Google OIDC token's `aud` is whatever the CALLER was configured with, and
 * we have two callers hitting two different paths on (currently) one service:
 * Cloud Tasks posts the deploy worker, Cloud Scheduler posts the publish
 * sweep. Keying solely on `DEPLOY_WORKER_URL` — as this did — means only the
 * deploy worker's URL is ever accepted, so a scheduler job configured with its
 * own path as audience fails verification and the sweep silently never runs.
 *
 * It also blocks moving the deploy worker to its own service: the moment
 * `DEPLOY_WORKER_URL` points elsewhere, the sweep on the portal starts
 * rejecting a correctly-signed token.
 *
 * So accept the request's own URL *and* `DEPLOY_WORKER_URL`. Both are URLs we
 * own, this is not a widening of trust — the signature and the service-account
 * email checks below are what actually authorise the call; `aud` only binds a
 * token to a destination, and both candidates ARE the destination.
 *
 * ⚠️ On Cloud Run the own-URL candidate is useless: Astro's Node adapter
 * builds `request.url` as `localhost` because it ignores `X-Forwarded-Host`
 * (see the same note in lib/csrf.ts, which is why the CSRF check compares
 * `Origin` against a host allowlist instead of `url.origin`). So there,
 * `DEPLOY_WORKER_URL` is the only candidate that can match, and a Cloud
 * Scheduler job must be configured with THAT as its audience rather than the
 * route it posts to. The own-URL candidate is what makes self-hosted and
 * non-Cloud-Run deployments work without setting the variable at all.
 */
export function expectedAudiences(request: Request): string[] {
  const own = new URL(request.url).toString();
  const configured = process.env.DEPLOY_WORKER_URL;
  return configured && configured !== own ? [own, configured] : [own];
}

export async function verifyInternalOidc(request: Request): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1];

  const expectedAudience = expectedAudiences(request);
  // Cloud Tasks (deploys) and Cloud Scheduler (sweeps) may run as
  // different service accounts; accept either configured identity.
  const expectedEmails = [
    process.env.CLOUD_TASKS_SERVICE_ACCOUNT,
    process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT,
  ].filter((e): e is string => !!e);
  if (expectedEmails.length === 0) return false;

  try {
    // The google-auth-library OAuth2Client.verifyIdToken handles JWKS fetch
    // + signature verify + exp/iat checks.
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken: token, audience: expectedAudience });
    const claims = ticket.getPayload();
    if (!claims) return false;
    if (!claims.email || !expectedEmails.includes(claims.email)) return false;
    if (claims.email_verified !== true) return false;
    return true;
  } catch {
    return false;
  }
}
