// Cloud Tasks worker. Receives an enqueued deploy job and executes it
// synchronously — the entire deploy runs within this request, which keeps
// the Cloud Run instance alive for the duration.
//
// Authentication: Cloud Tasks signs the request with the queue's service
// account using a Google-issued OIDC token. We verify the JWT against
// Google's JWKS and check the audience matches our own URL. Requests
// without a valid signed token are rejected — even though the route name
// is "internal", the URL is publicly reachable on Cloud Run.
//
// Idempotency: Cloud Tasks is at-least-once. We check the DeployJob doc
// before running; if it's already running/succeeded/failed, we no-op so a
// retried task can't double-deploy.
//
// Return codes matter for Cloud Tasks retries:
//   2xx = task consumed, won't retry
//   4xx = bad request, won't retry (we use this for "wrong signature")
//   5xx = retry per the queue's backoff policy — also how a busy instance
//         hands a task back when no build slot is free (see concurrency.ts).
//         Note this consumes a retry attempt: on a platform where deploys
//         routinely queue, raise the queue's --max-attempts.
// On unhandled exception we mark the job failed and return 2xx — we don't
// want Cloud Tasks to retry a deploy that failed for "the build broke" or
// "the credentials are wrong"; the user can hit Deploy again from the UI.

import type { APIRoute } from 'astro';
import { getStore } from '../../../lib/datastore';
import { executeDeployJob } from '../../../lib/deploy/queue';
import { slotWaitMs } from '../../../lib/deploy/concurrency';
import { paths } from '@typeroll/shared';
import type { DeployEnvironment, DeployJob } from '@typeroll/shared';

interface Payload {
  jobId: string;
  orgId: string;
  siteId: string;
  versionId: string;
  environment: DeployEnvironment;
  /** Build the site but skip the hosting-adapter upload. Must round-
   *  trip through Cloud Tasks intact — dropping it here turned every
   *  agent's `trigger_deploy dry_run=true` into a real prod deploy. */
  dryRun?: boolean;
}

export const POST: APIRoute = async ({ request }) => {
  // 1. Verify the OIDC token unless explicitly disabled for local dev.
  //    DEPLOY_WORKER_SKIP_AUTH=1 lets us hit the route from curl during
  //    development without a real Google token. Never set this in prod.
  const skipAuth = process.env.DEPLOY_WORKER_SKIP_AUTH === '1';
  if (!skipAuth) {
    const ok = await verifyOidcToken(request);
    if (!ok) return new Response('Unauthorized', { status: 401 });
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  if (!payload?.jobId || !payload?.orgId || !payload?.siteId) {
    return new Response('Missing required fields', { status: 400 });
  }

  // 2. Idempotency check. Read the job; bail if it's no longer in a state
  //    that should execute. Cloud Tasks treats 200 as "consumed", so a
  //    duplicate task is silently dropped.
  const store = getStore();
  const jobPath = paths.deploy(payload.orgId, payload.siteId, payload.jobId);
  const job = await store.getDoc<DeployJob>(jobPath);
  if (!job) {
    // Job vanished — nothing to do. Consume the task.
    return new Response(JSON.stringify({ ok: true, skipped: 'no_such_job' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (job.status !== 'queued') {
    return new Response(JSON.stringify({ ok: true, skipped: `status_${job.status}` }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Hand off to the shared execution path. executeDeployJob owns the
  //    job-doc lifecycle (running → succeeded/failed) and never throws.
  //    dryRun MUST be forwarded — without it the queue ran a real
  //    production deploy on dry_run=true requests.
  const outcome = await executeDeployJob(
    {
      jobId: payload.jobId,
      orgId: payload.orgId,
      siteId: payload.siteId,
      versionId: payload.versionId,
      environment: payload.environment,
      dryRun: payload.dryRun === true,
    },
    { slotWaitMs: slotWaitMs() },
  );

  // 4. No build slot came free in time — this instance is already building.
  //    Hand the task BACK (503 → Cloud Tasks redelivers per its backoff)
  //    rather than marking the job failed: congestion is not a broken build,
  //    and a failure the user can't act on is worse than a late deploy. The
  //    job doc is still `queued`, so the idempotency check above lets the
  //    redelivered task run.
  if (outcome === 'deferred') {
    return new Response(JSON.stringify({ ok: false, deferred: 'no_build_slot' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/**
 * Verify the OIDC Bearer token Cloud Tasks attaches to the request.
 * We accept the token if:
 *   - The Authorization header has a Bearer token
 *   - It verifies against Google's JWKS
 *   - The audience matches DEPLOY_WORKER_URL (or the request URL — same thing
 *     when the deploy-worker is hit at its canonical URL)
 *   - The "email" claim matches CLOUD_TASKS_SERVICE_ACCOUNT (defense in
 *     depth — only the queue's SA should be able to invoke us)
 */
async function verifyOidcToken(request: Request): Promise<boolean> {
  // Shared with /api/internal/publish-sweep — one verification contract
  // for every Google-signed internal route.
  const { verifyInternalOidc } = await import('../../../lib/internal-auth');
  return verifyInternalOidc(request);
}
